/**
 * Everything about this agent the shared runner cannot know: the pix-out
 * rail, the tool handlers, the words the operator at the keyboard reads, and
 * what a one-shot prints as JSON. The runner (`@codespar/agent-runtime`)
 * owns the rest.
 *
 * There is no `consent` and no `ensureMandate` here, and that is a decision
 * rather than an omission. The bills-agent's embedded consent is the partner
 * surface for a CONSUMER: the account holder is at the keyboard and
 * authorizes a mandate over their own money. The mandate behind a payroll is
 * the company's, minted by whoever owns finance, so the terminal is the
 * wrong place to be born. On the API rail this agent reads the signed
 * envelope the organization already holds; without one it refuses rather
 * than inventing a consent that nobody in the company authorized.
 */
import { join, relative } from "node:path";
import {
  ApiMandateStatusSource,
  CodeSparRail,
  NotATestKeyError,
  StubRail,
  createCodeSparClient,
  isTestKey,
  loadMandate,
  MandateSchema,
  type Execution,
  type Mandate,
} from "@codespar/agent-core";
import { existsSync, readFileSync } from "node:fs";
import { NoMandateError, defineAgent, type AgentKit } from "@codespar/agent-runtime";
import { formatBRL } from "./payables.js";
import { codesparLedger, codesparPay, listPayables } from "./modules/pix-out.js";

const mandatePath = (agentDir: string) => join(agentDir, ".codespar", "mandate.json");

function loadLocalMandate(path: string): Mandate | undefined {
  if (!existsSync(path)) return undefined;
  return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

const kit: AgentKit = {
  settlement: "immediate",
  scenarioRail: "stub",

  labels: {
    defaultUser: "usr_operator",
    evalUser: "usr_demo_financeiro",
    mandateWord: "mandato",
    receiptWord: "recibo",
    intro: 'Diga o que pagar ("roda a folha de outubro", "paga os fornecedores"). Ctrl+D ou "sair" encerra.',
    prompt: "> ",
    approveQuestion: "  Aprovar este pagamento? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita o pagamento)",
    missingReceiptKind: "receipt_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `receipt ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing — ${e.detail}; nothing was re-sent`,
  },

  usage: () => `supplier-payments-agent
  npm start                                         interactive terminal
  npm start -- --input "roda a folha de outubro"    one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                    run a scenario pack (${"see scenarios/"})
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>  --json
         --now <ISO 8601>  pin the run to that instant (escalation hours, timestamps); env CODESPAR_AGENT_NOW is the same thing
a batch runs one execution per line: in \`human\` the operator decides each one, and every artifact carries the batch_hash of the list it was one of`,

  buildRail: (ctx) => {
    if (ctx.kind === "api") {
      if (!isTestKey(ctx.env["CODESPAR_API_KEY"])) throw new NotATestKeyError();
      const api = createCodeSparClient({ apiKey: ctx.env["CODESPAR_API_KEY"], baseUrl: ctx.env["CODESPAR_API_URL"], projectId: ctx.env["CODESPAR_PROJECT_ID"] });
      const mandate = ctx.mandate ?? loadLocalMandate(mandatePath(ctx.agentDir));
      if (!mandate) throw new NoMandateError();
      return {
        rail: new CodeSparRail(api, { canonical: mandate.canonical, signature: mandate.signature }),
        mandate,
        api,
        // Section 4.7 against the real status: the local stub answers only runs without a key.
        status: new ApiMandateStatusSource(api, ctx.now),
      };
    }
    // SUPPLIER_PAYMENTS_KILL_AFTER_DISPATCH=1 simulates a crash right after the rail accepted the attempt and before the outcome was recorded.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // SUPPLIER_PAYMENTS_STUB_REFUSE=<payee,payee>: the stub rail refuses these payees, to drive a partial batch failure from a test process.
    const refuse = ctx.envVar("STUB_REFUSE") ? { refusePayees: ctx.envVar("STUB_REFUSE")!.split(",").map((p) => p.trim()).filter(Boolean) } : {};
    return {
      rail: new StubRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...refuse, ...(ctx.stubRail ?? {}) }),
      mandate: ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema)),
    };
  },

  handlers: () => ({ codespar_pay: codesparPay, codespar_ledger: codesparLedger, list_payables: listPayables }),

  describeExecution: (execution, setup) => {
    const lines: string[] = [];
    lines.push(`  execucao ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    for (const item of execution.items) lines.push(`    - ${item.beneficiary}: ${formatBRL(item.amount)}${item.description ? ` — ${item.description}` : ""}`);
    lines.push(`    total (calculado pelo core): ${formatBRL(execution.total)}`);
    if (execution.escalation) lines.push(`    escalado por: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
    if (execution.blocking_reasons.length) lines.push(`    bloqueado: ${execution.blocking_reasons.join(", ")} — o mandato nao autoriza; nao ha o que aprovar`);
    if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
    for (const outcome of execution.outcomes) {
      if (outcome.receipt_id) lines.push(`    recibo: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    return lines;
  },

  oneShotPayload: ({ setup: s, reply, toolCalls, executions }) => ({
    run_id: s.runId,
    agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
    mode: s.mode,
    rail: s.railKind,
    mandate_id: s.mandate.id,
    actor: s.engine.agentActor,
    reply,
    tool_calls: toolCalls,
    executions: executions.map((e) => ({
      id: e.id,
      state: e.state,
      reason: e.reason ?? null,
      escalation: e.escalation ?? null,
      total_minor: e.total,
      items: e.items.map((i) => ({ beneficiary: i.beneficiary, amount_minor: i.amount })),
      approval_id: e.approval_id ?? null,
      receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    })),
    // A batch is N executions, so what settled and what did not is a count, not a state.
    settled_minor: executions.filter((e) => e.state === "settled").reduce((sum, e) => sum + e.total, 0),
    failed_execution_ids: executions.filter((e) => ["failed", "denied", "expired"].includes(e.state)).map((e) => e.id),
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
  }),

  /** Payees with a prior settled payment under this mandate, so `new_beneficiary` is not what fires. */
  warmUp: async (s, aliases, approver) => {
    const warm = new Set<string>();
    for (const payee of aliases) {
      const d = await s.engine.draft({ items: [{ payee, amount: 100, description: "prior month" }] });
      if (!d.ok) throw new Error(`warm-up refused: ${d.reason}`);
      let e: Execution = d.execution;
      if (e.state === "awaiting_approval") e = s.engine.approve(e.id, approver);
      if (e.state === "approved") e = await s.engine.execute(e.id);
      if (e.state !== "settled") throw new Error(`warm-up for ${payee} ended ${e.state}`);
      warm.add(e.id);
    }
    return warm;
  },

  /** Webhook duplicated or out of order: the same `commerce.payment.succeeded` twice, and `paid` before `created`. */
  runEventsCase: async (s) => {
    const stub = s.rail as StubRail;
    const draft = await s.engine.draft({ items: [{ payee: "grafica", amount: 1000 }] });
    if (!draft.ok) throw new Error("refused");
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_demo_financeiro", channel: "terminal" });
    stub.armUncertainOnce();
    execution = await s.engine.execute(execution.id);
    const attempt = `att_${execution.idempotency_key.slice(4)}_0`;
    s.engine.ingestExternalEvent({ event_id: "evt_paid_1", type: "commerce.payment.succeeded", attempt_id: attempt });
    s.engine.ingestExternalEvent({ event_id: "evt_paid_1", type: "commerce.payment.succeeded", attempt_id: attempt });
    s.engine.ingestExternalEvent({ event_id: "evt_created_late", type: "commerce.payment.created", attempt_id: attempt });
    s.engine.ingestExternalEvent({ event_id: "evt_paid_2", type: "commerce.payment.succeeded", attempt_id: attempt });
  },

  // The rail's answers are part of the recording: a payee the rail refused in the original run is refused in the rerun.
  rerunPlan: (events) => {
    const dispatched = new Map(events.filter((e) => e["type"] === "rail.dispatch").map((e) => [(e["payload"] as { attempt_id: string }).attempt_id, (e["payload"] as { payee: string }).payee]));
    const refusePayees = events
      .filter((e) => e["type"] === "rail.outcome" && (e["payload"] as { status: string }).status === "failed")
      .map((e) => dispatched.get((e["payload"] as { attempt_id: string }).attempt_id))
      .filter((p): p is string => typeof p === "string");
    return { stubRail: { refusePayees } };
  },
  rerunComparesOutcomes: true,
};

export const agent = defineAgent(import.meta.url, kit);
