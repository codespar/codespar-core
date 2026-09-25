/**
 * Everything about this agent the shared runner cannot know: the bolepix
 * receivables rail and its sandbox payer, the negotiation envelope the core
 * runs as its `policyExtension`, the tool handlers, the words the payer and
 * the operator read, and what a one-shot prints as JSON. The runner
 * (`@codespar/agent-runtime`) owns the rest.
 *
 * There is no consent step: the collection policy is the MERCHANT's own (the
 * receiving side has no API-signed policy today, section 16), so the example
 * file is the policy in both rails.
 */
import { relative } from "node:path";
import qrcode from "qrcode-terminal";
import {
  CodeSparChargeRail,
  NotATestKeyError,
  StubChargeRail,
  createCodeSparClient,
  isTestKey,
  loadMandate,
  paySandboxCharge,
  type Execution,
  type StubChargeRailOptions,
} from "@codespar/agent-core";
import { defineAgent, type AgentKit } from "@codespar/agent-runtime";
import { formatBRL, formatDate } from "./agreements.js";
import { envelopePolicy, loadEnvelope } from "./envelope.js";
import { makeHandlers } from "./modules/bolepix-receivables.js";

const kit: AgentKit = {
  settlement: "await-payer",
  scenarioRail: "requested",

  labels: {
    defaultUser: "usr_operator",
    evalUser: "usr_operator",
    mandateWord: "politica",
    receiptWord: "registro",
    intro: 'Voce e o pagador. Diga algo ("oi, recebi a mensagem sobre o acordo do pedido 1042"). Ctrl+D ou "sair" encerra.',
    prompt: "pagador> ",
    approveQuestion: "  [operador] Aprovar a emissao desta cobranca? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a emissao)",
    missingReceiptKind: "record_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `paid charge ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing (${e.reason}) — ${e.detail}; nothing was re-issued; \`npm run poll\` keeps looking`,
    waitingForPayer: (round) => `  aguardando o pagador... (${round} consultas)`,
  },

  usage: () => `collections-agent
  npm start                                                    interactive terminal (you are the payer)
  npm start -- --input "oi, recebi a mensagem do acordo 1042"    one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                               run a scenario pack (see scenarios/)
  npm start -- --channel whatsapp --conversation <name>        the conversation channel (needs npm run whatsapp:emulator at the repo root)
  npm start -- --channel whatsapp --conversation <name> --scripted   the same, with the debtor's turns replayed from channels/whatsapp/
  npm run poll -- --channel whatsapp --conversation <name>     back to a conversation whose payment landed after the run ended:
                                                               mensagem livre com a janela de 24h aberta, template aprovado depois dela
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>
         --wait <seconds>  --simulate-payer  --payer pays|expires|never (stub only)  --json
         --now <ISO 8601>  pin the run to that instant (collection hours, due dates, timestamps); env CODESPAR_AGENT_NOW is the same thing
whatsapp: --backend simulator|cloud-api  default simulator, which is the local emulator; cloud-api is the same code pointed at Meta and needs your own credentials
          --conversation <name>          which channels/whatsapp/<name>.json binds the contact and the agreement
          --scripted                     replay that file's turns instead of reading them from the keyboard`,

  buildRail: (ctx) => {
    const mandate = ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema));
    if (ctx.kind === "api") {
      if (!isTestKey(ctx.env["CODESPAR_API_KEY"])) throw new NotATestKeyError();
      const client = createCodeSparClient({ apiKey: ctx.env["CODESPAR_API_KEY"], baseUrl: ctx.env["CODESPAR_API_URL"], projectId: ctx.env["CODESPAR_PROJECT_ID"] });
      return {
        rail: new CodeSparChargeRail(client),
        mandate,
        api: client,
        pollIntervalMs: 3000,
        payer: {
          kind: "api" as const,
          async pay(chargeId: string) {
            const result = await paySandboxCharge(client, chargeId);
            if (!result.ok) return { ok: false as const, detail: `${result.failure.code}: ${result.failure.message}` };
            const s = result.state;
            return { ok: true as const, detail: `sandbox payer: ${s.charge_id} ${s.status} (${s.payment}, ${s.paid_minor} of ${s.quoted_minor}), simulated=${s.simulated}, settled_against=${s.settled_against}, money_moved=${s.money_moved}${s.idempotent_replay ? ", replay" : ""}` };
          },
          behave() {
            /* the API's payer is a route, not a fixture; a scenario that needs "expires" declares rails: [stub] */
          },
        },
      };
    }
    // COLLECTIONS_KILL_AFTER_DISPATCH=1 simulates a crash right after the issuer accepted the charge and before the outcome was recorded.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // COLLECTIONS_STUB_PAYER=pays|expires|never: what the fixture payer does, from a test process.
    const behaviour = ctx.envVar("STUB_PAYER");
    const fixture: Pick<StubChargeRailOptions, "payer"> = behaviour === "pays" || behaviour === "expires" || behaviour === "never" ? { payer: behaviour } : {};
    const refuse = ctx.envVar("STUB_REFUSE") ? { refusePayees: ctx.envVar("STUB_REFUSE")!.split(",").map((p) => p.trim()).filter(Boolean) } : {};
    const stub = new StubChargeRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...fixture, ...refuse, ...(ctx.stubRail ?? {}) });
    return {
      rail: stub,
      mandate,
      pollIntervalMs: 0,
      payer: {
        kind: "stub" as const,
        async pay(_chargeId: string, attemptId: string) {
          stub.decide(attemptId, "pays");
          return { ok: true as const, detail: "stub payer: will pay at the next look" };
        },
        behave: (b) => stub.setPayer(b),
        // A receivable the rail has already looked at carries its fate in
        // state.db, and `setPayer` only changes the default for the ones it
        // has not. This is what lets a poll ask "and if nobody pays?" — the
        // due date passes between two runs, never inside one.
        decideFor: (attemptId, b) => stub.decide(attemptId, b),
      },
    };
  },

  handlers: (setup) => makeHandlers(loadEnvelope(setup.guardrails)),
  policyExtension: ({ guardrails }) => envelopePolicy(loadEnvelope(guardrails)),

  describeExecution: (execution, setup) => {
    const lines: string[] = [];
    const debtor = execution.items[0]?.beneficiary ?? "?";
    lines.push(`  execucao ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    lines.push(`    acordo de ${debtor} (${execution.items[0]?.alias ?? "?"})`);
    for (const [i, item] of execution.items.entries()) lines.push(`    - parcela ${i + 1}/${execution.items.length}: ${formatBRL(item.amount)}, vence ${item.due_date ? formatDate(item.due_date) : "?"}`);
    lines.push(`    total (calculado pelo core): ${formatBRL(execution.total)}`);
    if (execution.escalation) lines.push(`    escalado por: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
    if (execution.blocking_reasons.length) lines.push(`    bloqueado: ${execution.blocking_reasons.join(", ")} — a politica nao autoriza; nao ha o que aprovar`);
    if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
    for (const outcome of execution.outcomes) {
      if (outcome.transaction_id) lines.push(`    cobranca ${outcome.index + 1}: ${outcome.transaction_id} — ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}`);
      if (outcome.receipt_id) lines.push(`    registro: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    return lines;
  },

  oneShotPayload: ({ setup: s, reply, toolCalls, executions, startedAt }) => ({
    run_id: s.runId,
    agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
    mode: s.mode,
    rail: s.railKind,
    policy_id: s.mandate.id,
    actor: s.engine.agentActor,
    reply,
    tool_calls: toolCalls,
    executions: executions.map((e) => ({
      id: e.id,
      state: e.state,
      reason: e.reason ?? null,
      escalation: e.escalation ?? null,
      total_minor: e.total,
      items: e.items.map((i) => ({ debtor: i.beneficiary, amount_minor: i.amount, due_date: i.due_date ?? null })),
      approval_id: e.approval_id ?? null,
      charges: e.outcomes.map((o) => ({ instalment: o.index + 1, charge_id: o.transaction_id ?? null, status: o.status, code: o.code ?? null, payable: o.instrument?.payable ?? null, pix_copy_paste: o.instrument?.pix_copy_paste ?? null })),
      receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
    })),
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
    seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
  }),

  /** What the payer reads when a receivable is payable: the QR as an image, the copy-and-paste under it, the bank line if any. */
  presentInstrument: (execution, instalment, chargeId, instrument, tell) => {
    const item = execution.items[instalment - 1];
    const count = execution.items.length;
    tell("");
    tell(`${count > 1 ? `Parcela ${instalment}/${count}: ` : ""}${item ? formatBRL(item.amount) : ""}${instrument.due_date ? `, vence ${formatDate(instrument.due_date)}` : ""} — cobranca ${chargeId}`);
    if (instrument.pix_copy_paste) {
      qrcode.generate(instrument.pix_copy_paste, { small: true }, (qr: string) => {
        for (const line of qr.split("\n")) tell(line);
      });
      tell("Pix copia e cola:");
      tell(instrument.pix_copy_paste);
    }
    if (instrument.boleto_bank_line) {
      tell("Ou pelo boleto, linha digitavel:");
      tell(instrument.boleto_bank_line);
    }
    tell("");
  },

  announceOutcome: (execution, setup, tell) => {
    if (execution.state === "executing") return false;
    if (!setup.engine.markTold(execution.id, execution.state)) return false;
    let text: string;
    if (execution.state === "settled") text = `Recebemos, acordo quitado. Obrigado! (${execution.outcomes.map((o) => o.transaction_id).filter(Boolean).join(", ")})`;
    else if (execution.reason === "charge_expired") text = "A cobranca venceu sem pagamento. Se quiser, emito uma nova dentro das mesmas condicoes.";
    else if (execution.reason === "charge_cancelled") text = "A cobranca foi cancelada. Nada foi pago.";
    else if (execution.state === "failed") text = `Nao consegui emitir a cobranca (${execution.reason ?? "falha no trilho"}). Nada foi cobrado.`;
    else if (execution.state === "denied") text = `Nao posso emitir nesses termos (${execution.reason ?? "recusado"}).`;
    else text = `A proposta expirou sem decisao (${execution.state}).`;
    tell(text);
    setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, text });
    return true;
  },

  /**
   * The same outcome as `announceOutcome`, as one of the templates this agent
   * declares in `channels/whatsapp/templates.json`. It is what a poll sends
   * when the 24-hour window has shut, which for a collection is the ordinary
   * case and not the edge one: agreed Tuesday, paid Friday.
   *
   * Three outcomes have approved copy and the rest return undefined on
   * purpose. A charge that failed on the rail, a proposal that was denied or
   * one that expired without a decision are not things this agent has ever
   * had to say to a debtor days later — the first two are answered inside the
   * turn that produced them, and inventing a template for them would mean
   * asking Meta to approve copy nobody has written. The poll REPORTS an
   * outcome it cannot carry rather than sending an approximate one.
   */
  outcomeTemplate: (execution) => {
    const agreement = execution.items[0]?.alias ?? execution.items[0]?.beneficiary;
    if (!agreement) return undefined;
    if (execution.state === "settled") return { template: "acordo_quitado", variables: [agreement] };
    if (execution.reason === "charge_expired") return { template: "acordo_cobranca_vencida", variables: [agreement] };
    if (execution.reason === "charge_cancelled") return { template: "acordo_cobranca_cancelada", variables: [agreement] };
    return undefined;
  },

  /** Agreements with a prior settled receivable under this policy, so the velocity window has history. */
  warmUp: async (s, aliases, approver) => {
    const warm = new Set<string>();
    for (const alias of aliases) {
      const d = await s.engine.draft({ items: [{ payee: alias, amount: 20000, due_date: "2026-09-30", description: "prior instalment" }] });
      if (!d.ok) throw new Error(`warm-up refused: ${d.reason}`);
      let e: Execution = d.execution;
      if (e.state === "awaiting_approval") e = s.engine.approve(e.id, approver);
      if (e.state === "approved") e = await s.engine.execute(e.id);
      for (let i = 0; i < 2 && e.state === "executing"; i += 1) e = await s.engine.reconcile(e.id);
      if (e.state !== "settled") throw new Error(`warm-up for ${alias} ended ${e.state} (${e.reason})`);
      warm.add(e.id);
    }
    return warm;
  },

  /** Webhook duplicated or out of order: the same `commerce.charge.paid` twice, `paid` before `created`, `expired` after `paid`. One settled, one message. */
  runEventsCase: async (s, tell) => {
    s.payer!.behave("never");
    const draft = await s.engine.draft({ items: [{ payee: "acordo-1042", amount: 108000, due_date: "2026-09-30" }] });
    if (!draft.ok) throw new Error("refused");
    let execution = draft.execution;
    if (execution.state === "awaiting_approval") execution = s.engine.approve(execution.id, { id: "usr_operator", channel: "terminal" });
    execution = await s.engine.execute(execution.id);
    const chargeId = execution.outcomes[0]!.transaction_id!;
    const apply = (event_id: string, type: string) => {
      s.engine.ingestExternalEvent({ event_id, type, transaction_id: chargeId });
      kit.announceOutcome!(s.engine.get(execution.id)!, s, tell);
    };
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_paid_1", "commerce.charge.paid");
    apply("evt_created_late", "commerce.charge.created");
    apply("evt_paid_2", "commerce.charge.paid");
    apply("evt_expired_late", "commerce.charge.expired");
  },

  // The payer's behaviour is part of the recording: a receivable that expired in the original run expires in the rerun.
  rerunPlan: (events) => {
    const expired = events.some((e) => e["type"] === "execution.transition" && (e["payload"] as { reason?: string }).reason === "charge_expired");
    return { stubRail: { payer: expired ? "expires" : "pays" }, simulatePayer: !expired };
  },
  rerunComparesOutcomes: false,

  evalScenarioLine: (check) =>
    `${check.ok ? "ok  " : "FAIL"} scenario/${check.run.scenario} [${check.mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.charges_issued} charge(s), ${check.run.receipts} record(s), ${check.run.debtor_messages} message(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`,
};

export const agent = defineAgent(import.meta.url, kit);
