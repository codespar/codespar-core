/**
 * Module `bolepix-receivables`: the tool handlers the model can reach.
 * `codespar_charge` hands the proposal to the engine and gets an execution in
 * `drafted` (then whatever the core decided); it cannot issue anything.
 * `list_agreements` is a read. The real call (`POST /v1/charges`, one
 * cobranca com vencimento per instalment, `idempotency_key` per attempt) is
 * built by the rail from the execution the core approved.
 */
import type { ToolHandler } from "@codespar/agent-core";
import { AGREEMENTS, agreementByAlias, formatBRL, formatDate } from "../agreements.js";
import type { Envelope } from "../envelope.js";

interface ChargeInput {
  action?: unknown;
  agreement?: unknown;
  instalments?: unknown;
  total_minor?: unknown;
  execution_id?: unknown;
}

export function makeHandlers(envelope: Envelope): Record<string, ToolHandler> {
  const listAgreements: ToolHandler = async (_input, ctx) => {
    const settled = ctx.engine.list({ state: "settled" });
    const open = ctx.engine.list({ state: "executing" });
    // Issued, then its reference turned ambiguous: the charge exists and may be paid. Not open, and the core refuses another until it is reconciled.
    const unreconciled = ctx.engine.list({ state: "failed" }).filter((e) => e.reason === "charge_reference_ambiguous");
    const unreconciledAliases = new Set(unreconciled.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
    const settledAliases = new Set(settled.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
    const issuedAliases = new Set(open.flatMap((e) => e.items.map((i) => i.alias)).filter(Boolean));
    return {
      agreements: AGREEMENTS.map((a) => ({
        alias: a.alias,
        debtor_first_name: a.first_name,
        principal_minor: a.principal_minor,
        principal: formatBRL(a.principal_minor),
        origin: a.origin,
        opened_at: a.opened_at,
        status: settledAliases.has(a.alias)
          ? "quitado"
          : issuedAliases.has(a.alias)
            ? "cobranca emitida, aguardando pagamento"
            : unreconciledAliases.has(a.alias)
              ? "cobranca emitida, em conferencia: nao emitir outra"
              : "em aberto",
      })),
      envelope: {
        max_discount_pct: envelope.max_discount_pct,
        max_instalments: envelope.max_instalments,
        due_date_window_days: envelope.due_date_window_days,
        min_instalment_minor: envelope.min_instalment_minor,
        collection_hours: envelope.collection_hours,
      },
    };
  };

  const codesparCharge: ToolHandler = async (raw, ctx) => {
    const input = raw as ChargeInput;
    const action = input.action ?? "create";
    if (action === "status") {
      if (typeof input.execution_id !== "string") throw new Error("codespar_charge: execution_id is required for action=status");
      const execution = ctx.engine.get(input.execution_id);
      if (!execution) return { found: false, message: "no execution with that id in this run" };
      return { found: true, ...describe(execution) };
    }
    if (action !== "create") throw new Error(`codespar_charge: unsupported action ${String(action)}; this agent only creates and reads receivables`);
    if (typeof input.agreement !== "string" || !input.agreement.trim()) throw new Error("codespar_charge: agreement must be an agreement alias from list_agreements");
    if (!Array.isArray(input.instalments) || input.instalments.length === 0) throw new Error("codespar_charge: instalments must be a non-empty array");
    const alias = input.agreement.trim().toLowerCase();
    const agreement = agreementByAlias(alias);
    const count = input.instalments.length;
    const items = input.instalments.map((entry, i) => {
      const it = entry as { amount_minor?: unknown; due_date?: unknown };
      if (typeof it.amount_minor !== "number" || !Number.isInteger(it.amount_minor) || it.amount_minor <= 0) throw new Error(`codespar_charge: instalments[${i}].amount_minor must be a positive integer`);
      if (typeof it.due_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(it.due_date)) throw new Error(`codespar_charge: instalments[${i}].due_date must be YYYY-MM-DD`);
      return {
        payee: alias,
        amount: it.amount_minor,
        due_date: it.due_date,
        description: `${agreement ? `Acordo ${agreement.alias.replace("acordo-", "#")}` : `Acordo ${alias}`} - parcela ${i + 1}/${count}`,
      };
    });
    const claimed = typeof input.total_minor === "number" ? { claimed_total: input.total_minor } : {};

    const draft = await ctx.engine.draft({ items, ...claimed });
    if (!draft.ok) return { status: "refused", reason: draft.reason, message: draft.message, issued: false, paid: false };
    const execution = await ctx.onExecution(draft.execution);
    return describe(execution);
  };

  return { codespar_charge: codesparCharge, list_agreements: listAgreements };
}

function describe(execution: import("@codespar/agent-core").Execution) {
  const charges = execution.outcomes.map((o) => ({
    instalment: o.index + 1,
    charge_id: o.transaction_id ?? null,
    status: o.status,
    ...(o.instrument ? { payable: o.instrument.payable, pix_copy_paste: o.instrument.pix_copy_paste, boleto_bank_line: o.instrument.boleto_bank_line, due_date: o.instrument.due_date } : {}),
    ...(o.code ? { code: o.code } : {}),
  }));
  return {
    status: execution.state,
    execution_id: execution.id,
    total_minor: execution.total,
    total: formatBRL(execution.total),
    instalments: execution.items.map((i, n) => ({ instalment: n + 1, amount: formatBRL(i.amount), due_date: i.due_date ? formatDate(i.due_date) : null })),
    ...(execution.reason ? { reason: execution.reason, detail: execution.detail } : {}),
    ...(execution.escalation ? { escalated_by: execution.escalation.trigger } : {}),
    charges,
    issued: execution.reason === "charge_reference_ambiguous" ? execution.state === "failed" : charges.length > 0 && charges.every((c) => c.status !== "failed"),
    ...(execution.reason === "charge_reference_ambiguous" ? { reconcile_before_reissue: true } : {}),
    paid: execution.state === "settled",
    expired: execution.state === "failed" && execution.reason === "charge_expired",
  };
}
