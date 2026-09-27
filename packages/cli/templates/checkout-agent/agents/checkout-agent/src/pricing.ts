/**
 * The price and discount envelope, as pure functions: what the agent may sell
 * on its own, applied by deterministic code. `priceCart` turns what the model
 * proposed (`[{ sku, quantity }]`, a coupon, a negotiated discount) into a
 * priced cart with structured `validation_issues`; `checkOrder` is the gate
 * the core runs as its `policyExtension` at draft, at approval and right
 * before the charge is issued (checkout §2, §3.3, §7.4).
 *
 * The prices are the catalog's and nothing else's. No input the model can
 * write carries a price: a line is a SKU, a quantity and at most a discount in
 * percent, and the totals are computed here. The sales policy is not signed by
 * the API (there is no sales-side policy there, checkout §3.3), so it lives in
 * `guardrails.json` under `envelope`, and every rule of it can only refuse.
 */
import { z } from "zod";
import { compositionHash, isOutsideHours, localClock, type CompositionLine, type Execution, type ExecutionReason, type Guardrails } from "@codespar/agent-core";
import { catalogItem, formatBRL } from "./catalog.js";

const HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export const CouponSchema = z
  .object({
    code: z.string().regex(/^[A-Z0-9]+$/),
    discount_pct: z.number().positive().max(100),
    min_order_minor: z.number().int().nonnegative(),
    expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export const EnvelopeSchema = z
  .object({
    /** The largest negotiated discount on one line, in percent. */
    max_discount_pct: z.number().min(0).max(100),
    /** The largest negotiated discount on the whole order, in percent. A coupon is the merchant's own and is not negotiated. */
    max_order_discount_pct: z.number().min(0).max(100),
    /** No line, and not the order, may sell below this margin over the catalog cost. */
    min_margin_pct: z.number().min(0).max(100),
    max_units_per_line: z.number().int().positive(),
    /** The ticket ceiling. */
    max_order_minor: z.number().int().positive(),
    /** The charge falls due today, and never later than this many days from today. */
    due_date_window_days: z.number().int().nonnegative(),
    /** The hours the store sells, `HH:MM-HH:MM` in `guardrails.timezone`. Outside them nothing is ordered or issued, in either mode. */
    service_hours: z.string().regex(HOURS),
    /** The merchant's coupon table. A code that is not here does not exist. */
    coupons: z.array(CouponSchema),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;
export type Coupon = z.infer<typeof CouponSchema>;

export function loadEnvelope(guardrails: Guardrails): Envelope {
  if (!guardrails.envelope) throw new Error("guardrails.json has no `envelope`; the checkout-agent needs one");
  return EnvelopeSchema.parse(guardrails.envelope);
}

/** The closed vocabulary of checkout §2.2. `message` is for the person; a test reads `code`. */
export type IssueCode = "sku_unknown" | "item_unavailable" | "quantity_invalid" | "quantity_above_stock" | "coupon_unknown" | "coupon_not_applicable" | "price_not_caller_input" | "cart_empty";

export interface ValidationIssue {
  code: IssueCode;
  field: string;
  message: string;
}

/** An ACP-shaped line (`LineItem`): the item, the quantity, and totals the code computed. */
export interface PricedLine {
  id: string;
  item: { id: string; name: string; unit_amount: number };
  sku: string;
  name: string;
  quantity: number;
  unit_amount: number;
  /** Negotiated, in percent; 0 when none. */
  discount_pct: number;
  availability_status: "in_stock" | "low_stock";
  totals: Array<{ type: "items_base_amount" | "items_discount" | "total"; display_text: string; amount: number }>;
}

/** An order-level discount: the merchant's coupon, or one negotiated inside the envelope. A line of the composition with a negative amount. */
export interface OrderDiscount {
  kind: "coupon" | "negotiated";
  ref: string;
  pct: number;
  amount: number;
}

export interface PricedCart {
  line_items: PricedLine[];
  coupon: string | null;
  order_discounts: OrderDiscount[];
  /** ACP `Total` entries: items_base_amount, items_discount, subtotal, discount, total. */
  totals: Array<{ type: string; display_text: string; amount: number }>;
  total: number;
  validation_issues: ValidationIssue[];
  /** What `cart_hash` is computed over, in order: one line per cart line, then one per order discount. */
  composition: CompositionLine[];
  cart_hash: string;
}

/** Fields a line may not carry. A price said in the conversation has no field to arrive in; one that arrives anyway refuses the whole line. */
const PRICE_FIELDS = ["price", "price_minor", "unit_price", "unit_amount", "amount", "amount_minor", "total", "total_minor", "value", "valor", "preco"];

const lineTotal = (line: PricedLine) => line.totals.find((t) => t.type === "total")!.amount;
const lineBase = (line: PricedLine) => line.totals.find((t) => t.type === "items_base_amount")!.amount;

/** `YYYY-MM-DD` of `now` in the zone. */
export function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface CartInput {
  lines: unknown;
  coupon?: unknown;
  order_discount_pct?: unknown;
}

/**
 * Prices a full replacement of the cart. Nothing is merged with what the cart
 * held before (checkout §2.1): the lines passed ARE the cart. A line that
 * fails validation is left out and named in `validation_issues`; the rest is
 * priced from the catalog. A coupon that does not exist, or does not apply,
 * is named and not applied, and nothing "equivalent" is applied in its place.
 */
export function priceCart(input: CartInput, envelope: Envelope, today: string): PricedCart {
  const issues: ValidationIssue[] = [];
  const lines: PricedLine[] = [];
  const raw = Array.isArray(input.lines) ? input.lines : [];
  if (!Array.isArray(input.lines)) throw new Error("lines must be an array of { sku, quantity } (an empty array empties the cart)");
  const seen = new Set<string>();

  for (const [i, entry] of raw.entries()) {
    const field = `lines[${i}]`;
    const line = (entry ?? {}) as Record<string, unknown>;
    const priced = PRICE_FIELDS.find((f) => f in line);
    if (priced) {
      issues.push({ code: "price_not_caller_input", field: `${field}.${priced}`, message: "o preco vem do catalogo da loja; a linha foi recusada inteira" });
      continue;
    }
    const sku = typeof line["sku"] === "string" ? line["sku"].trim().toLowerCase() : "";
    const item = sku ? catalogItem(sku) : undefined;
    if (!item) {
      issues.push({ code: "sku_unknown", field: `${field}.sku`, message: `nao temos ${sku || "esse item"} no catalogo` });
      continue;
    }
    if (!item.available) {
      issues.push({ code: "item_unavailable", field: `${field}.sku`, message: `${item.title} esta indisponivel` });
      continue;
    }
    const quantity = line["quantity"];
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0 || quantity > envelope.max_units_per_line) {
      issues.push({ code: "quantity_invalid", field: `${field}.quantity`, message: `quantidade deve ser um inteiro de 1 a ${envelope.max_units_per_line}` });
      continue;
    }
    if (seen.has(item.sku)) {
      issues.push({ code: "quantity_invalid", field: `${field}.sku`, message: `${item.sku} aparece mais de uma vez; uma linha por item, com a quantidade total` });
      continue;
    }
    if (item.stock !== undefined && quantity > item.stock) {
      issues.push({ code: "quantity_above_stock", field: `${field}.quantity`, message: `so ha ${item.stock} de ${item.title}` });
      continue;
    }
    const discount = line["discount_pct"] ?? 0;
    if (typeof discount !== "number" || !Number.isFinite(discount) || discount < 0 || discount > 100) throw new Error(`${field}.discount_pct must be a percentage between 0 and 100`);
    seen.add(item.sku);
    const base = item.price_minor * quantity;
    const off = Math.round((base * discount) / 100);
    lines.push({
      id: `line_${lines.length + 1}`,
      item: { id: item.sku, name: item.title, unit_amount: item.price_minor },
      sku: item.sku,
      name: item.title,
      quantity,
      unit_amount: item.price_minor,
      discount_pct: discount,
      availability_status: item.stock !== undefined && item.stock - quantity <= 1 ? "low_stock" : "in_stock",
      totals: [
        { type: "items_base_amount", display_text: "Valor", amount: base },
        { type: "items_discount", display_text: "Desconto", amount: -off },
        { type: "total", display_text: "Total da linha", amount: base - off },
      ],
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const orderDiscounts: OrderDiscount[] = [];
  let coupon: string | null = null;
  if (input.coupon !== undefined && input.coupon !== null && input.coupon !== "") {
    if (typeof input.coupon !== "string") throw new Error("coupon must be a string");
    const code = input.coupon.trim().toUpperCase();
    const found = envelope.coupons.find((c) => c.code === code);
    if (!found) issues.push({ code: "coupon_unknown", field: "coupon", message: `o cupom ${code} nao existe nesta loja` });
    else if (found.expires_at < today) issues.push({ code: "coupon_not_applicable", field: "coupon", message: `o cupom ${code} expirou` });
    else if (subtotal < found.min_order_minor) issues.push({ code: "coupon_not_applicable", field: "coupon", message: `o cupom ${code} vale para pedidos a partir de ${formatBRL(found.min_order_minor)}` });
    else {
      coupon = code;
      orderDiscounts.push({ kind: "coupon", ref: `coupon:${code}`, pct: found.discount_pct, amount: Math.round((subtotal * found.discount_pct) / 100) });
    }
  }
  if (input.order_discount_pct !== undefined && input.order_discount_pct !== null) {
    const pct = input.order_discount_pct;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error("order_discount_pct must be a percentage between 0 and 100");
    if (pct > 0) orderDiscounts.push({ kind: "negotiated", ref: "discount:order", pct, amount: Math.round((subtotal * pct) / 100) });
  }

  const orderOff = orderDiscounts.reduce((sum, d) => sum + d.amount, 0);
  const total = subtotal - orderOff;
  const composition: CompositionLine[] = [
    ...lines.map((l) => ({ ref: l.sku, quantity: l.quantity, unit_amount: l.unit_amount, amount: lineTotal(l), currency: "BRL" })),
    ...orderDiscounts.map((d) => ({ ref: d.ref, quantity: 1, unit_amount: -d.amount, amount: -d.amount, currency: "BRL" })),
  ];
  const itemsBase = lines.reduce((sum, l) => sum + lineBase(l), 0);
  return {
    line_items: lines,
    coupon,
    order_discounts: orderDiscounts,
    totals: [
      { type: "items_base_amount", display_text: "Itens", amount: itemsBase },
      { type: "items_discount", display_text: "Descontos nos itens", amount: subtotal - itemsBase },
      { type: "subtotal", display_text: "Subtotal", amount: subtotal },
      { type: "discount", display_text: "Desconto do pedido", amount: -orderOff },
      { type: "total", display_text: "Total", amount: total },
    ],
    total,
    validation_issues: issues,
    composition,
    cart_hash: compositionHash(composition),
  };
}

export interface OrderVerdict {
  reason: ExecutionReason;
  detail: string;
}

/**
 * The gate. `cart` is the cart the execution's composition names, as it is
 * NOW; `undefined` when it cannot be found. The details never quote the
 * envelope's numbers or a cost: the maximum discount and the margin floor are
 * negotiation information (checkout §5.6, exfiltration).
 */
export function checkOrder(execution: Pick<Execution, "items" | "total" | "composition">, cart: PricedCart | undefined, envelope: Envelope, now: Date, timezone: string): OrderVerdict | undefined {
  const [open, close] = envelope.service_hours.split("-") as [string, string];
  if (isOutsideHours(`${close}-${open}`, now, timezone)) {
    return { reason: "outside_hours", detail: `fora do horario de atendimento (${envelope.service_hours} ${timezone}); agora sao ${localClock(now, timezone)}` };
  }
  if (execution.items.length !== 1) return { reason: "outside_envelope", detail: "um pedido e uma cobranca: um item, cujo valor e o total do carrinho" };
  if (!execution.composition) return { reason: "outside_envelope", detail: "um pedido nasce de um carrinho; esta execucao nao nomeia nenhum" };
  if (!cart) return { reason: "outside_envelope", detail: `o carrinho ${execution.composition.ref} nao existe neste estado` };
  if (cart.cart_hash !== execution.composition.composition_hash) return { reason: "outside_envelope", detail: "o pedido nao corresponde ao carrinho atual; o carrinho mudou depois" };
  if (cart.line_items.length === 0) return { reason: "outside_envelope", detail: "carrinho vazio" };
  if (cart.validation_issues.length > 0) return { reason: "outside_envelope", detail: `o carrinho tem pendencias (${cart.validation_issues.map((i) => i.code).join(", ")})` };
  if (execution.total !== cart.total || execution.items[0]!.amount !== cart.total) return { reason: "outside_envelope", detail: `o pedido cobra ${execution.total} e o carrinho soma ${cart.total}` };

  for (const line of cart.line_items) {
    const item = catalogItem(line.sku);
    if (!item || !item.available) return { reason: "outside_envelope", detail: `${line.sku} nao esta a venda` };
    if (line.unit_amount !== item.price_minor) return { reason: "outside_envelope", detail: `${line.sku} nao esta pelo preco de tabela` };
    if (line.quantity > envelope.max_units_per_line || (item.stock !== undefined && line.quantity > item.stock)) return { reason: "outside_envelope", detail: `quantidade de ${line.sku} fora do permitido` };
    if (line.discount_pct > envelope.max_discount_pct) return { reason: "outside_envelope", detail: `desconto em ${line.sku} acima do que a politica da loja permite` };
    const total = lineTotal(line);
    if (marginBelow(total, item.cost_minor * line.quantity, envelope.min_margin_pct)) return { reason: "outside_envelope", detail: `${line.sku} ficaria abaixo do piso de margem da loja` };
  }
  const negotiated = cart.order_discounts.filter((d) => d.kind === "negotiated");
  const coupons = cart.order_discounts.filter((d) => d.kind === "coupon");
  if (negotiated.some((d) => d.pct > envelope.max_order_discount_pct)) return { reason: "outside_envelope", detail: "desconto no pedido acima do que a politica da loja permite" };
  if (negotiated.length > 0 && coupons.length > 0) return { reason: "outside_envelope", detail: "cupom e desconto negociado nao se somam" };
  const today = localDate(now, timezone);
  for (const c of coupons) {
    const code = c.ref.replace(/^coupon:/, "");
    const found = envelope.coupons.find((x) => x.code === code);
    if (!found || found.expires_at < today || c.pct !== found.discount_pct) return { reason: "outside_envelope", detail: `o cupom ${code} nao vale para este pedido` };
  }
  const cost = cart.line_items.reduce((sum, l) => sum + (catalogItem(l.sku)?.cost_minor ?? 0) * l.quantity, 0);
  if (marginBelow(cart.total, cost, envelope.min_margin_pct)) return { reason: "outside_envelope", detail: "o pedido ficaria abaixo do piso de margem da loja" };
  if (cart.total > envelope.max_order_minor) return { reason: "outside_envelope", detail: `pedido de ${formatBRL(cart.total)} acima do ticket maximo da loja` };

  const due = execution.items[0]!.due_date;
  if (!due) return { reason: "outside_envelope", detail: "a cobranca do pedido nao tem vencimento" };
  const last = addDays(today, envelope.due_date_window_days);
  if (due < today || due > last) return { reason: "outside_envelope", detail: `vencimento ${due} fora da janela da loja (de ${today} ate ${last})` };
  return undefined;
}

function marginBelow(price: number, cost: number, minPct: number): boolean {
  if (price <= 0) return true;
  return (price - cost) * 100 < minPct * price;
}
