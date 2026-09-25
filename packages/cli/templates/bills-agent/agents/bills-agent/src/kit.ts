/**
 * Everything about this agent the shared runner cannot know: the pix-out
 * rail, the mandate that is born at a consent, the tool handlers, the words
 * the person at the keyboard reads, and what a one-shot prints as JSON.
 * The runner (`@codespar/agent-runtime`) owns the rest.
 */
import { join, relative, resolve } from "node:path";
import {
  ApiMandateStatusSource,
  CodeSparRail,
  NotATestKeyError,
  StubRail,
  createCodeSparClient,
  isTestKey,
  loadMandate,
  type Execution,
} from "@codespar/agent-core";
import { NoMandateError, defineAgent, type AgentKit } from "@codespar/agent-runtime";
import { formatBRL } from "./bills.js";
import { loadLocalMandate, runEmbeddedConsent } from "./modules/embedded-consent.js";
import { codesparLedger, codesparPay, listBills } from "./modules/pix-out.js";

const mandatePath = (agentDir: string) => join(agentDir, ".codespar", "mandate.json");

const kit: AgentKit = {
  settlement: "immediate",
  scenarioRail: "stub",

  labels: {
    defaultUser: "usr_terminal",
    evalUser: "usr_demo_titular",
    mandateWord: "mandato",
    receiptWord: "recibo",
    intro: 'Diga o que pagar ("pague a escola de outubro"). Ctrl+D ou "sair" encerra.',
    prompt: "> ",
    approveQuestion: "  Aprovar este pagamento? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita o pagamento)",
    missingReceiptKind: "receipt_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `receipt ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing — ${e.detail}; nothing was re-sent`,
  },

  usage: () => `bills-agent
  npm start                                         interactive terminal
  npm start -- --input "pague a escola de outubro"  one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                    run a scenario pack (${"see scenarios/"})
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>  --json
         --now <ISO 8601>  pin the run to that instant (escalation hours, timestamps); env CODESPAR_AGENT_NOW is the same thing`,

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
    // BILLS_KILL_AFTER_DISPATCH=1 simulates a crash right after the rail accepted the attempt and before the outcome was recorded.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // BILLS_STUB_REFUSE=<payee,payee>: the stub rail refuses these payees, to drive a partial failure from a test process.
    const refuse = ctx.envVar("STUB_REFUSE") ? { refusePayees: ctx.envVar("STUB_REFUSE")!.split(",").map((p) => p.trim()).filter(Boolean) } : {};
    return {
      rail: new StubRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...refuse, ...(ctx.stubRail ?? {}) }),
      mandate: ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema)),
    };
  },

  handlers: () => ({ codespar_pay: codesparPay, codespar_ledger: codesparLedger, list_bills: listBills }),

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
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
  }),

  // Embedded consent: with a test key and no signed mandate, the mandate is born first.
  ensureMandate: async (ctx) => {
    if (ctx.railKind !== "api") return true;
    const path = mandatePath(ctx.agentDir);
    if (loadLocalMandate(path)) return true;
    if (ctx.oneShot) {
      ctx.say(new NoMandateError().message);
      return false;
    }
    const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: process.env["CODESPAR_API_URL"], projectId: process.env["CODESPAR_PROJECT_ID"] });
    const example = loadMandate(resolve(ctx.agentDir, "mandate.example.json"));
    await runEmbeddedConsent({ api, example, mandatePath: path, say: ctx.say, confirm: async (q: string) => /^(s|sim|y|yes)$/i.test((await ctx.ask(q)).trim()) });
    return true;
  },

  /**
   * `npm run consent -- --yes` (or `npm run consent --yes`, which npm keeps as
   * `npm_config_yes`): the partner-surface consent for a new mandate with the
   * test key, stored locally and credited in the sandbox.
   */
  consent: async (ctx) => {
    const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: process.env["CODESPAR_API_URL"], projectId: process.env["CODESPAR_PROJECT_ID"] });
    const example = loadMandate(resolve(ctx.agentDir, "mandate.example.json"));
    const yes = ctx.argv.includes("--yes") || process.env["npm_config_yes"] === "true";
    const confirm = async (question: string): Promise<boolean> => {
      if (yes) return true;
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question(question)).trim();
      rl.close();
      return /^(s|sim|y|yes)$/i.test(answer);
    };
    const mandate = await runEmbeddedConsent({ api, example, mandatePath: mandatePath(ctx.agentDir), say: ctx.say, confirm });
    ctx.say(`mandato ${mandate.id} salvo em .codespar/mandate.json`);
    return 0;
  },

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
    const draft = await s.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!draft.ok) throw new Error("refused");
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_demo_titular", channel: "terminal" });
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
