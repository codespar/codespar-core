/**
 * Module `bolepix-receivables`, the sales version: the `codespar_charge`
 * handler. A copy of the collections-agent's module in its bones (agents do
 * not import each other's modules, OPEN_QUESTIONS §39f) and different in what
 * it charges: an ORDER, one cobranca com vencimento whose amount is the
 * cart's total as the code priced it, due today (checkout decision 1).
 *
 * Three actions, because ordering and issuing are two moments of a sale:
 *
 * - `create` turns the cart into an order: ONE execution, one item (the
 *   customer, the cart's total, today's due date) and the cart's composition
 *   bound to it. The code checks it at every gate; in `approval: human` the
 *   attendant confirms it, in `approval: mandate` the policy does. Nothing is
 *   issued.
 * - `issue` hands the approved order to `engine.execute`, which runs the last
 *   gate: a cart changed since the approval sends the order back to a person
 *   (`items_hash_mismatch`). Only then does the rail call `POST /v1/charges`,
 *   with the customer's name and document from the policy and the attempt id
 *   as `idempotency_key`, so asking twice returns the same charge.
 * - `status` reads.
 *
 * No input carries an amount. `total_minor` is recorded and, with
 * `model_total_mismatch: refuse`, refuses a total the model got wrong.
 */
import type { Execution, ExecutionEngine, Proposal, ToolHandler } from "@codespar/agent-core";
import { MERCHANT, formatBRL, formatDate } from "../catalog.js";
import { localDate } from "../pricing.js";
import { claimOrder, currentCart, orderOf, resolveCart, type Cart, type CartBook } from "./storefront-cart.js";

interface ChargeInput {
  action?: unknown;
  cart_id?: unknown;
  customer?: unknown;
  payment?: unknown;
  total_minor?: unknown;
  execution_id?: unknown;
}

export interface OrderDeps {
  book: CartBook;
  runId: string;
  timezone: string;
  clock: () => Date;
  /** The customer a channel's conversation is bound to, when one is: an order in this conversation is theirs. */
  boundCustomer?: () => string | undefined;
}

const OPEN = new Set(["awaiting_approval", "approved"]);

/** The proposal an order is: the customer, the cart's total due today, and the cart's composition. */
export function orderProposal(cart: Cart, customer: string, deps: Pick<OrderDeps, "timezone" | "clock">, claimedTotal?: number): Proposal {
  return {
    items: [{ payee: customer, amount: cart.total, due_date: localDate(deps.clock(), deps.timezone), description: `${MERCHANT.name} - pedido ${cart.cart_id}` }],
    composition: { ref: cart.ref, composition_hash: cart.cart_hash, line_count: cart.composition.length },
    ...(claimedTotal !== undefined ? { claimed_total: claimedTotal } : {}),
  };
}

/**
 * A cart replaced while its order is open: the order follows the cart
 * (`restate`), and the gates judge it on what it says now. An APPROVED order
 * keeps the artifact of the old cart, which is exactly what the last gate
 * compares. A cart left empty or with pending issues is not an order anyone
 * can issue; the order is left as it was and every gate refuses it, because
 * the policy compares the order with the CURRENT cart.
 */
export function followCart(cart: Cart, engine: ExecutionEngine, deps: Pick<OrderDeps, "timezone" | "clock">): Execution | undefined {
  const order = orderOf(engine, cart);
  if (!order || !OPEN.has(order.state)) return undefined;
  if (order.composition?.composition_hash === cart.cart_hash) return order;
  if (cart.line_items.length === 0 || cart.validation_issues.length > 0) return order;
  const customer = order.items[0]!.alias ?? order.items[0]!.payee;
  return engine.restate(order.id, orderProposal(cart, customer, deps));
}

export function makeChargeHandlers(deps: OrderDeps): Record<string, ToolHandler> {
  const findOrder = (engine: ExecutionEngine, input: ChargeInput): { order: Execution | undefined; cart: Cart | undefined } => {
    if (typeof input.execution_id === "string" && input.execution_id) {
      const order = engine.get(input.execution_id);
      if (!order) throw new Error(`no order ${input.execution_id} in this state`);
      return { order, cart: order.composition ? deps.book.get(order.composition.ref) : undefined };
    }
    const cart = resolveCart(engine, deps, input.cart_id);
    return { order: cart ? orderOf(engine, cart) : undefined, cart };
  };

  const codesparCharge: ToolHandler = async (raw, ctx) => {
    const input = raw as ChargeInput;
    const action = input.action ?? "create";
    if (input.payment !== undefined && input.payment !== "bolepix") throw new Error(`codespar_charge: payment ${String(input.payment)} is not offered; the order is charged by bolepix (Pix or boleto on one charge)`);

    if (action === "status") {
      const { order, cart } = findOrder(ctx.engine, input);
      if (!order) return { found: false, message: cart ? `o carrinho ${cart.cart_id} ainda nao virou pedido` : "nenhum pedido nesta conversa" };
      return { found: true, ...describe(order, cart) };
    }

    if (action === "issue") {
      const { order, cart } = findOrder(ctx.engine, input);
      if (!order) throw new Error("codespar_charge: no order to issue; create the order from the cart first (action=create)");
      if (order.state !== "approved") return { ...describe(order, cart), message: messageFor(order) };
      // The cart may have moved since the order was approved; the order follows it, and the last gate compares.
      if (cart) followCart(cart, ctx.engine, deps);
      const executed = await ctx.engine.execute(order.id);
      const handled = await ctx.onExecution(executed);
      return describe(handled, cart ?? undefined);
    }

    if (action !== "create") throw new Error(`codespar_charge: unsupported action ${String(action)}; this agent creates an order, issues its charge and reads it`);
    const cart = input.cart_id === undefined ? (currentCart(ctx.engine, deps) ?? deps.book.latest(deps.runId)) : resolveCart(ctx.engine, deps, input.cart_id);
    if (!cart || cart.line_items.length === 0) throw new Error("codespar_charge: cart_empty — the cart has no lines; nothing is ordered");
    if (cart.validation_issues.length > 0) {
      throw new Error(`codespar_charge: the cart has pending validation_issues (${cart.validation_issues.map((i) => i.code).join(", ")}); replace the cart without them (cart_update) before ordering. Nothing was ordered.`);
    }
    if (typeof input.customer !== "string" || !input.customer.trim()) throw new Error("codespar_charge: customer must be the alias of the customer you are talking to (their first name, lowercase)");
    const customer = input.customer.trim().toLowerCase();
    // The contact binding is what identifies the customer on a channel. A charge in anybody else's name — even another
    // customer of the store, whom the policy would allow — is refused before an order exists.
    const bound = deps.boundCustomer?.();
    if (bound && customer !== bound) throw new Error(`codespar_charge: this conversation is with ${bound}; an order here is charged to ${bound} and to nobody else. Nothing was ordered.`);

    const existing = orderOf(ctx.engine, cart);
    if (existing && (OPEN.has(existing.state) || existing.state === "executing" || existing.state === "settled")) {
      if (OPEN.has(existing.state)) followCart(cart, ctx.engine, deps);
      const current = ctx.engine.get(existing.id)!;
      return { ...describe(current, cart), message: `este carrinho ja e o pedido ${current.id}; nada novo foi criado` };
    }

    const claimed = typeof input.total_minor === "number" ? input.total_minor : undefined;
    const draft = await ctx.engine.draft(orderProposal(cart, customer, deps, claimed));
    if (!draft.ok) return { status: "refused", reason: draft.reason, message: draft.message, issued: false, paid: false };
    claimOrder(ctx.engine, cart, draft.execution.id);
    const decided = await ctx.onExecution(draft.execution);
    return { ...describe(decided, cart), message: messageFor(decided) };
  };

  return { codespar_charge: codesparCharge };
}

function messageFor(order: Execution): string {
  switch (order.state) {
    case "approved":
      return "pedido confirmado; a cobranca sai quando o cliente pedir (action=issue)";
    case "awaiting_approval":
      return order.reason === "items_hash_mismatch" ? "o carrinho mudou depois da confirmacao; o pedido voltou para o atendente" : "aguardando o atendente confirmar o pedido";
    case "executing":
      return order.reason === "awaiting_settlement" ? "cobranca emitida; aguardando o pagamento" : "desfecho da emissao desconhecido; nada sera reemitido";
    case "settled":
      return "pago";
    default:
      return `${order.state}${order.reason ? ` (${order.reason})` : ""}`;
  }
}

export function describe(order: Execution, cart: Cart | undefined) {
  const outcome = order.outcomes[0];
  return {
    status: order.state,
    execution_id: order.id,
    cart_id: cart?.cart_id ?? order.composition?.ref ?? null,
    customer: order.items[0]?.alias ?? null,
    total_minor: order.total,
    total: formatBRL(order.total),
    due_date: order.items[0]?.due_date ? formatDate(order.items[0].due_date) : null,
    ...(order.reason ? { reason: order.reason, detail: order.detail } : {}),
    ...(order.escalation ? { escalated_by: order.escalation.trigger } : {}),
    charge: outcome
      ? {
          charge_id: outcome.transaction_id ?? null,
          status: outcome.status,
          ...(outcome.instrument ? { payable: outcome.instrument.payable, pix_copy_paste: outcome.instrument.pix_copy_paste, boleto_bank_line: outcome.instrument.boleto_bank_line } : {}),
          ...(outcome.code ? { code: outcome.code } : {}),
        }
      : null,
    issued: order.reason === "charge_reference_ambiguous" ? order.state === "failed" : order.outcomes.length > 0 && order.outcomes.every((o) => o.status !== "failed"),
    paid: order.state === "settled",
    expired: order.state === "failed" && order.reason === "charge_expired",
  };
}
