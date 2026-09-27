/**
 * Module `storefront-cart`: the cart, kept by the agent in `state.db` (there
 * is no sales-side cart in the API, checkout §9.1), and the three local tools
 * the model reaches it by. The rules are checkout §2's, applied here by code:
 *
 * - `cart_update` REPLACES the cart with the lines it is given. Nothing is
 *   merged; an empty list empties it (§2.1).
 * - Every answer carries `validation_issues: [{ code, field, message }]` from
 *   a closed vocabulary (§2.2).
 * - The totals are computed here from the catalog; no input carries a price
 *   (§2.3).
 *
 * The shapes follow the ACP `CheckoutSession` the enterprise cart already
 * uses (`line_items`, `totals`, `status`), so a server-side cart one day is a
 * change of storage and not of contract.
 *
 * A cart id the model sees (`cart-1`) counts within the run; the ref the
 * execution carries (`<run_id>/cart-1`) is unique across runs, so an order
 * approved from another process (`npm run approve`) finds its cart.
 */
import type { ExecutionEngine, StateStore, ToolHandler } from "@codespar/agent-core";
import { CATALOG, MERCHANT, formatBRL } from "../catalog.js";
import { localDate, priceCart, type Envelope, type PricedCart, type ValidationIssue } from "../pricing.js";

export interface Cart extends PricedCart {
  cart_id: string;
  ref: string;
  run_id: string;
  version: number;
  currency: "BRL";
  order_discount_pct: number;
  updated_at: string;
}

/** ACP `CheckoutStatus`, derived from the order: the cart does not decide it, the execution does. */
export type CartStatus = "in_progress" | "ready_for_payment" | "completed";

const KEY = (ref: string) => `checkout:cart:${ref}`;
const RUN_KEY = (runId: string) => `checkout:carts:${runId}`;
const ORDER_KEY = (ref: string) => `order:${ref}`;

/** The carts, in state.db's key-value table beside the execution cursors. */
export class CartBook {
  constructor(private readonly store: StateStore) {}

  get(ref: string): Cart | undefined {
    const raw = this.store.getCursor(KEY(ref));
    return raw ? (JSON.parse(raw) as Cart) : undefined;
  }

  save(cart: Cart): void {
    this.store.setCursor(KEY(cart.ref), JSON.stringify(cart));
    const ids = this.idsOf(cart.run_id);
    if (!ids.includes(cart.cart_id)) this.store.setCursor(RUN_KEY(cart.run_id), JSON.stringify([...ids, cart.cart_id]));
  }

  idsOf(runId: string): string[] {
    const raw = this.store.getCursor(RUN_KEY(runId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  byId(runId: string, cartId: string): Cart | undefined {
    return this.get(`${runId}/${cartId}`);
  }

  latest(runId: string): Cart | undefined {
    const ids = this.idsOf(runId);
    const last = ids[ids.length - 1];
    return last ? this.byId(runId, last) : undefined;
  }

  nextId(runId: string): string {
    return `cart-${this.idsOf(runId).length + 1}`;
  }
}

/** The order a cart belongs to, if one was placed: the execution the claim names. */
export function orderOf(engine: ExecutionEngine, cart: Pick<Cart, "ref">) {
  const id = engine.claimed(ORDER_KEY(cart.ref));
  return id ? engine.get(id) : undefined;
}

export function claimOrder(engine: ExecutionEngine, cart: Pick<Cart, "ref">, executionId: string): void {
  engine.claim(ORDER_KEY(cart.ref), executionId);
}

export function statusOf(engine: ExecutionEngine, cart: Cart): CartStatus {
  const order = orderOf(engine, cart);
  if (order?.state === "settled") return "completed";
  if (order?.state === "executing") return "ready_for_payment";
  return "in_progress";
}

/** A cart whose charge is out or paid is the record of that sale: it is not edited, a new cart is. */
export function isLocked(engine: ExecutionEngine, cart: Cart): boolean {
  return statusOf(engine, cart) !== "in_progress";
}

/** What the model reads: the cart, its totals as text, its issues, and the order it belongs to. Never a cost, never the envelope's limits. */
export function viewOf(engine: ExecutionEngine, cart: Cart) {
  const order = orderOf(engine, cart);
  return {
    cart_id: cart.cart_id,
    version: cart.version,
    status: statusOf(engine, cart),
    currency: cart.currency,
    line_items: cart.line_items.map((l) => ({
      id: l.id,
      sku: l.sku,
      name: l.name,
      quantity: l.quantity,
      unit_price: formatBRL(l.unit_amount),
      ...(l.discount_pct ? { discount_pct: l.discount_pct } : {}),
      total: formatBRL(l.totals.find((t) => t.type === "total")!.amount),
      availability_status: l.availability_status,
    })),
    coupon: cart.coupon,
    totals: cart.totals.map((t) => ({ type: t.type, display_text: t.display_text, amount: formatBRL(t.amount) })),
    total_minor: cart.total,
    total: formatBRL(cart.total),
    validation_issues: cart.validation_issues,
    cart_hash: cart.cart_hash,
    order: order ? { execution_id: order.id, state: order.state, ...(order.reason ? { reason: order.reason } : {}) } : null,
  };
}

interface UpdateInput {
  cart_id?: unknown;
  lines?: unknown;
  coupon?: unknown;
  order_discount_pct?: unknown;
}

export interface CartDeps {
  book: CartBook;
  envelope: Envelope;
  runId: string;
  timezone: string;
  clock: () => Date;
  /** Called after a replacement, with the cart as it is now: an open order follows it (`bolepix-receivables`). */
  onReplaced(cart: Cart, engine: ExecutionEngine): void;
}

/** The cart a call without `cart_id` means: the last one of this conversation that is still being assembled. */
export function currentCart(engine: ExecutionEngine, deps: Pick<CartDeps, "book" | "runId">): Cart | undefined {
  const cart = deps.book.latest(deps.runId);
  return cart && !isLocked(engine, cart) ? cart : undefined;
}

export function resolveCart(engine: ExecutionEngine, deps: Pick<CartDeps, "book" | "runId">, cartId: unknown): Cart | undefined {
  if (cartId === undefined || cartId === null || cartId === "") return deps.book.latest(deps.runId);
  if (typeof cartId !== "string") throw new Error("cart_id must be a string (cart-1)");
  const cart = deps.book.byId(deps.runId, cartId.trim());
  if (!cart) throw new Error(`no cart ${cartId} in this conversation; carts: ${deps.book.idsOf(deps.runId).join(", ") || "none yet"}`);
  return cart;
}

export function makeCartHandlers(deps: CartDeps): Record<string, ToolHandler> {
  const listCatalog: ToolHandler = async () => ({
    merchant: MERCHANT.name,
    items: CATALOG.map((i) => ({
      sku: i.sku,
      title: i.title,
      category: i.category,
      price: formatBRL(i.price_minor),
      price_minor: i.price_minor,
      available: i.available,
      ...(i.stock !== undefined ? { stock: i.stock } : {}),
    })),
    policy: {
      service_hours: deps.envelope.service_hours,
      payment: "bolepix (cobranca com vencimento): paga por Pix ou por boleto, vence hoje",
      discounts: "so dentro da politica da loja, aplicada pelo codigo; o que estiver fora e recusado. Cupom: so os da tabela da loja, informados pelo cliente.",
      prices: "sempre os do catalogo; nenhuma ferramenta aceita preco",
    },
  });

  const cartView: ToolHandler = async (raw, ctx) => {
    const input = raw as { cart_id?: unknown };
    const cart = resolveCart(ctx.engine, deps, input.cart_id);
    if (!cart) return { cart: null, message: "nenhum carrinho aberto nesta conversa; cart_update abre um" };
    return viewOf(ctx.engine, cart);
  };

  const cartUpdate: ToolHandler = async (raw, ctx) => {
    const input = raw as UpdateInput;
    let target: Cart | undefined;
    if (input.cart_id !== undefined && input.cart_id !== null && input.cart_id !== "") {
      target = resolveCart(ctx.engine, deps, input.cart_id);
      if (target && isLocked(ctx.engine, target)) throw new Error(`cart ${target.cart_id} is the record of an order whose charge is ${statusOf(ctx.engine, target) === "completed" ? "paid" : "out"}; it is not edited. Omit cart_id to open a new cart.`);
    } else target = currentCart(ctx.engine, deps);

    const now = deps.clock();
    const priced = priceCart({ lines: input.lines, coupon: input.coupon, order_discount_pct: input.order_discount_pct }, deps.envelope, localDate(now, deps.timezone));
    const cartId = target?.cart_id ?? deps.book.nextId(deps.runId);
    const cart: Cart = {
      ...priced,
      cart_id: cartId,
      ref: `${deps.runId}/${cartId}`,
      run_id: deps.runId,
      version: (target?.version ?? 0) + 1,
      currency: "BRL",
      order_discount_pct: typeof input.order_discount_pct === "number" ? input.order_discount_pct : 0,
      updated_at: now.toISOString(),
    };
    deps.book.save(cart);
    ctx.engine.note("cart.replaced", orderOf(ctx.engine, cart)?.id ?? null, {
      cart_ref: cart.ref,
      version: cart.version,
      cart_hash: cart.cart_hash,
      lines: cart.composition,
      total_minor: cart.total,
      validation_issues: cart.validation_issues.map((i: ValidationIssue) => ({ code: i.code, field: i.field })),
    });
    deps.onReplaced(cart, ctx.engine);
    return viewOf(ctx.engine, cart);
  };

  return { list_catalog: listCatalog, cart_view: cartView, cart_update: cartUpdate };
}
