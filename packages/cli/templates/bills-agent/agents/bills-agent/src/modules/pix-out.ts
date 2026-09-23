/**
 * Module `pix-out`: the tool handlers the model can reach. `codespar_pay`
 * hands the proposal to the engine and gets an execution in `drafted` (then
 * whatever the core decided); it cannot pay. `codespar_ledger` and
 * `list_bills` are reads.
 */
import type { ToolHandler } from "@codespar/agent-core";
import { formatBRL } from "../bills.js";
import { BILLS, MONTH } from "../bills.js";

interface PayInput {
  action?: unknown;
  items?: unknown;
  total_minor?: unknown;
}

export const listBills: ToolHandler = async (_input, ctx) => {
  const settled = ctx.engine.list({ state: "settled" });
  const paidAliases = new Set(settled.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
  return {
    month: MONTH,
    bills: BILLS.map((b) => ({ ...b, amount: formatBRL(b.amount_minor), paid_this_window: paidAliases.has(b.alias) })),
    payees: ctx.engine.mandate.beneficiaries.map((b) => ({ alias: b.alias, name: b.name })),
  };
};

export const codesparPay: ToolHandler = async (raw, ctx) => {
  const input = raw as PayInput;
  if (input.action !== "pix") throw new Error(`codespar_pay: unsupported action ${String(input.action)}; this agent only does pix`);
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("codespar_pay: items must be a non-empty array");
  const items = input.items.map((item, i) => {
    const it = item as { payee?: unknown; amount_minor?: unknown; description?: unknown };
    if (typeof it.payee !== "string" || !it.payee.trim()) throw new Error(`codespar_pay: items[${i}].payee must be a payee alias`);
    if (typeof it.amount_minor !== "number" || !Number.isInteger(it.amount_minor) || it.amount_minor <= 0) throw new Error(`codespar_pay: items[${i}].amount_minor must be a positive integer`);
    return { payee: it.payee, amount: it.amount_minor, ...(typeof it.description === "string" ? { description: it.description } : {}) };
  });
  const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};

  const draft = await ctx.engine.draft({ items, ...claimed });
  if (!draft.ok) {
    return { status: "refused", reason: draft.reason, message: draft.message, paid: false };
  }
  const execution = await ctx.onExecution(draft.execution);
  return {
    status: execution.state,
    execution_id: execution.id,
    total_minor: execution.total,
    total: formatBRL(execution.total),
    items: execution.items.map((i) => ({ payee: i.beneficiary, amount: formatBRL(i.amount) })),
    ...(execution.reason ? { reason: execution.reason, detail: execution.detail } : {}),
    ...(execution.escalation ? { escalated_by: execution.escalation.trigger } : {}),
    receipt_ids: execution.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    paid: execution.state === "settled",
  };
};

export const codesparLedger: ToolHandler = async (raw, ctx) => {
  const input = raw as { action?: unknown; receipt_id?: unknown };
  if (input.action === "executions") {
    return {
      executions: ctx.engine.list().map((e) => ({ id: e.id, state: e.state, total: formatBRL(e.total), reason: e.reason ?? null, receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id) })),
    };
  }
  if (input.action === "receipt") {
    if (typeof input.receipt_id !== "string") throw new Error("codespar_ledger: receipt_id is required for action=receipt");
    const owner = ctx.engine.list().find((e) => e.outcomes.some((o) => o.receipt_id === input.receipt_id));
    if (!owner) return { found: false, message: "no receipt with that id in this mandate's executions" };
    const outcome = owner.outcomes.find((o) => o.receipt_id === input.receipt_id)!;
    const item = owner.items[outcome.index];
    return { found: true, receipt_id: outcome.receipt_id, state: owner.state, payee: item?.beneficiary, amount: item ? formatBRL(item.amount) : null, mandate_id: owner.mandate.id };
  }
  throw new Error(`codespar_ledger: unsupported action ${String(input.action)}`);
};
