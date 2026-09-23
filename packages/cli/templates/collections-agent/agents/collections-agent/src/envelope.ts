/**
 * Module `bolepix-receivables`, the envelope: what the agent may agree on
 * its own, applied by deterministic code at every gate of the core. The
 * model negotiates inside it; the code confers before the proposal leaves
 * (section 7, step 2). The policy of the receiving side is not signed by
 * the API today (section 16), so it lives in `guardrails.json` under
 * `envelope` and the core runs it as its `policyExtension`.
 *
 * Every rule here can only refuse. None of them widens the collection
 * policy (the debtors' book, the cap per receivable, the window cap).
 */
import { z } from "zod";
import { isOutsideHours, localClock, type Execution, type ExecutionReason, type Guardrails, type PolicyExtension } from "@codespar/agent-core";
import { agreementByDocument, type Agreement } from "./agreements.js";

export const EnvelopeSchema = z
  .object({
    /** The largest discount over the principal, in percent. */
    max_discount_pct: z.number().min(0).max(100),
    max_instalments: z.number().int().positive(),
    /** A due date may be at most this many days from today. */
    due_date_window_days: z.number().int().positive(),
    min_instalment_minor: z.number().int().positive(),
    /** The hours a debtor may be contacted, `HH:MM-HH:MM` in `guardrails.timezone`. Outside them nothing is proposed or issued. */
    collection_hours: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;

export function loadEnvelope(guardrails: Guardrails): Envelope {
  if (!guardrails.envelope) throw new Error("guardrails.json has no `envelope`; the collections-agent needs one");
  return EnvelopeSchema.parse(guardrails.envelope);
}

/** The floor of an agreement: the principal minus the maximum discount, rounded up so the discount never exceeds the ceiling by a cent. */
export function floorMinor(agreement: Agreement, envelope: Envelope): number {
  return Math.ceil((agreement.principal_minor * (100 - envelope.max_discount_pct)) / 100);
}

/** `YYYY-MM-DD` of `now` in the zone. */
export function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface EnvelopeVerdict {
  reason: ExecutionReason;
  detail: string;
}

/** The pure check, for tests and for the tool handler's early answer. `undefined` means inside the envelope. */
export function checkEnvelope(execution: Pick<Execution, "items" | "total">, envelope: Envelope, now: Date, timezone: string): EnvelopeVerdict | undefined {
  // Collection hours are the law's, not the merchant's: the window in which a debtor may be contacted at all.
  const [open, close] = envelope.collection_hours.split("-") as [string, string];
  if (isOutsideHours(`${close}-${open}`, now, timezone)) {
    return { reason: "outside_hours", detail: `fora do horario de cobranca (${envelope.collection_hours} ${timezone}); agora sao ${localClock(now, timezone)}` };
  }

  const documents = new Set(execution.items.map((i) => i.payee));
  if (documents.size !== 1) return { reason: "outside_envelope", detail: "one execution covers one agreement; the items name more than one debtor" };
  const document = execution.items[0]!.payee;
  const agreement = agreementByDocument(document);
  // A debtor the allowlist does not name is refused by the core before this runs; a named one without a book entry is a fixture defect.
  if (!agreement) return { reason: "outside_envelope", detail: "no open agreement for this debtor" };

  if (execution.items.length > envelope.max_instalments) {
    return { reason: "outside_envelope", detail: `${execution.items.length} parcelas; o envelope permite ate ${envelope.max_instalments}` };
  }
  const floor = floorMinor(agreement, envelope);
  if (execution.total < floor) {
    const pct = Math.round((1 - execution.total / agreement.principal_minor) * 1000) / 10;
    return { reason: "outside_envelope", detail: `total ${execution.total} e ${pct}% abaixo do principal ${agreement.principal_minor}; o desconto maximo e ${envelope.max_discount_pct}% (piso ${floor})` };
  }
  if (execution.total > agreement.principal_minor) {
    return { reason: "outside_envelope", detail: `total ${execution.total} acima do principal ${agreement.principal_minor}; nao se cobra mais do que se deve` };
  }
  const small = execution.items.find((i) => i.amount < envelope.min_instalment_minor);
  if (small) return { reason: "outside_envelope", detail: `parcela de ${small.amount} abaixo do minimo ${envelope.min_instalment_minor}` };

  const today = localDate(now, timezone);
  const last = addDays(today, envelope.due_date_window_days);
  let previous = "";
  for (const [i, item] of execution.items.entries()) {
    if (!item.due_date) return { reason: "outside_envelope", detail: `parcela ${i + 1} sem vencimento` };
    if (item.due_date < today) return { reason: "outside_envelope", detail: `vencimento ${item.due_date} da parcela ${i + 1} ja passou (hoje e ${today})` };
    if (item.due_date > last) return { reason: "outside_envelope", detail: `vencimento ${item.due_date} da parcela ${i + 1} fora da janela de ${envelope.due_date_window_days} dias (ate ${last})` };
    if (item.due_date < previous) return { reason: "outside_envelope", detail: `parcela ${i + 1} vence antes da anterior` };
    previous = item.due_date;
  }
  return undefined;
}

export function envelopePolicy(envelope: Envelope): PolicyExtension {
  return (execution, ctx) => checkEnvelope(execution, envelope, ctx.now, ctx.guardrails.timezone);
}
