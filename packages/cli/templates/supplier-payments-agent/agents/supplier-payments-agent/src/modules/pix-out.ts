/**
 * Module `pix-out`: the tool handlers the model can reach. `codespar_pay`
 * hands a proposal to the engine and gets executions in `drafted` (then
 * whatever the core decided); it cannot pay. `codespar_ledger` and
 * `list_payables` are reads.
 *
 * `codespar_pay` has two shapes and they are not interchangeable. With
 * `batch_ref` it runs a named batch, whose lines come from `payables.ts` and
 * never from the call: see `refuseTamperedBatch` below, which is the reason
 * a model cannot split a batch line or add a payee to a batch. With `items`
 * it proposes one execution the way the bills-agent does, for the one-off
 * supplier payment that is not part of a run.
 */
import type { ToolHandler } from "@codespar/agent-core";
import { BATCHES, MONTH, batchTotal, findBatch, formatBRL } from "../payables.js";
import { lineStatus, runBatch } from "./batch-payout.js";

interface PayInput {
  action?: unknown;
  batch_ref?: unknown;
  items?: unknown;
  total_minor?: unknown;
}

export const listPayables: ToolHandler = async (_input, ctx) => {
  return {
    month: MONTH,
    batches: BATCHES.map((b) => ({
      batch_ref: b.ref,
      kind: b.kind,
      label: b.label,
      due: b.due,
      total: formatBRL(batchTotal(b)),
      total_minor: batchTotal(b),
      lines: b.lines.map((l) => ({
        alias: l.alias,
        name: l.name,
        amount: formatBRL(l.amount_minor),
        amount_minor: l.amount_minor,
        reference: l.reference,
        // What a previous run of this batch already covers. An `open` line is
        // the only kind this agent will pay.
        status: lineStatus(b, l, ctx),
      })),
    })),
    payees: ctx.engine.mandate.beneficiaries.map((b) => ({ alias: b.alias, name: b.name })),
  };
};

/**
 * A batch call that also carries its own lines is refused, whatever the
 * lines say. The batch's membership is the company's, recorded in the
 * payables file; a call that supplies both is either a model that
 * misunderstood the tool or one that is being steered, and there is no
 * reading of it that this agent should act on.
 */
function refuseTamperedBatch(input: PayInput): void {
  if (input.items === undefined && input.total_minor === undefined) return;
  throw new Error(
    "codespar_pay: a batch is expanded from the payables file, so batch_ref cannot be sent with items or total_minor. Call it with batch_ref alone, or drop batch_ref to propose a one-off payment.",
  );
}

export const codesparPay: ToolHandler = async (raw, ctx) => {
  const input = raw as PayInput;
  if (input.action !== "pix") throw new Error(`codespar_pay: unsupported action ${String(input.action)}; this agent only does pix`);

  if (input.batch_ref !== undefined) {
    if (typeof input.batch_ref !== "string" || !input.batch_ref.trim()) throw new Error("codespar_pay: batch_ref must be a batch_ref from list_payables");
    refuseTamperedBatch(input);
    const batch = findBatch(input.batch_ref.trim());
    if (!batch) throw new Error(`codespar_pay: unknown batch_ref ${input.batch_ref}; list_payables names the batches of the month`);
    const report = await runBatch(batch, ctx);
    return { ...report, paid: report.failed.length === 0 && report.settled_minor > 0 };
  }

  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error("codespar_pay: items must be a non-empty array (or send batch_ref to run a batch)");
  const items = input.items.map((item, i) => {
    const it = item as { payee?: unknown; amount_minor?: unknown; description?: unknown };
    if (typeof it.payee !== "string" || !it.payee.trim()) throw new Error(`codespar_pay: items[${i}].payee must be a payee alias`);
    if (typeof it.amount_minor !== "number" || !Number.isInteger(it.amount_minor) || it.amount_minor <= 0) throw new Error(`codespar_pay: items[${i}].amount_minor must be a positive integer`);
    return { payee: it.payee, amount: it.amount_minor, ...(typeof it.description === "string" ? { description: it.description } : {}) };
  });
  const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};

  const draft = await ctx.engine.draft({ items, ...claimed });
  if (!draft.ok) return { status: "refused", reason: draft.reason, message: draft.message, paid: false };
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
