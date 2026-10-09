/**
 * What an agent gets when it declares nothing: the stub payment rail over the
 * example mandate, the generic console words, and no tools. A read-only agent
 * spreads this and adds its handlers; a payer or a collector replaces the rail.
 */
import { StubRail, formatBRL, isReplayedSettlement, loadMandate, railErrorOf, type Execution, type LocaleTable } from "@codespar/agent-core";
import { relative } from "node:path";
import type { AgentKit, KitStrings } from "./kit.js";
import type { Setup } from "./setup.js";

/**
 * The lines a payment execution reads as on the console, in the run's locale:
 * the default kit's, and the bills and supplier agents', which pay the same
 * way and describe it the same way.
 */
export function describePayment(execution: Execution, setup: Setup): string[] {
  const text = setup.coreStrings;
  const words = setup.strings;
  const lines: string[] = [];
  lines.push(`  ${text.execution} ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
  for (const item of execution.items) lines.push(`    - ${item.beneficiary}: ${formatBRL(item.amount, setup.locale)}${item.description ? ` — ${item.description}` : ""}`);
  lines.push(`    ${text.totalByCore}: ${formatBRL(execution.total, setup.locale)}`);
  if (execution.escalation) lines.push(`    ${text.escalatedBy}: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
  if (execution.blocking_reasons.length) lines.push(`    ${text.blocked(execution.blocking_reasons.join(", "), words.notAuthorized)}`);
  if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
  if (isReplayedSettlement(execution)) lines.push(`    ${text.replayedSettlement}`);
  for (const outcome of execution.outcomes) {
    if (outcome.receipt_id) lines.push(`    ${words.receiptWord}: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
  }
  return lines;
}

export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}R$ ${Math.floor(abs / 100).toLocaleString("pt-BR")},${String(abs % 100).padStart(2, "0")}`;
}

export const DEFAULT_STRINGS: LocaleTable<KitStrings> = {
  "pt-BR": {
    mandateWord: "mandato",
    receiptWord: "recibo",
    intro: 'Diga o que precisa. Ctrl+D ou "sair" encerra.',
    prompt: "> ",
    approveQuestion: "  Aprovar? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a operação)",
    notAuthorized: "o mandato não autoriza",
  },
  en: {
    mandateWord: "mandate",
    receiptWord: "receipt",
    intro: 'Say what you need. Ctrl+D or "exit" ends.',
    prompt: "> ",
    approveQuestion: "  Approve? [y/N] ",
    uncertainDispatch: "  outcome unknown on the rail; run `npm run resume` to reconcile (never repeat the operation)",
    notAuthorized: "the mandate does not authorize it",
  },
};

export const defaultKit: AgentKit = {
  settlement: "immediate",
  scenarioRail: "stub",
  labels: {
    defaultUser: "usr_terminal",
    evalUser: "usr_demo_titular",
    missingReceiptKind: "receipt_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `receipt ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing — ${e.detail}; nothing was re-sent`,
  },
  strings: DEFAULT_STRINGS,
  usage: (manifest) => `${manifest.manifest.name}
  npm start                              interactive terminal
  npm start -- --input "..."             one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>         run a scenario pack (see scenarios/)
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>  --json
         --now <ISO 8601>  pin the run to that instant; env CODESPAR_AGENT_NOW is the same thing
         --locale pt-BR|en  the language of what the code prints; default: agent.yaml \`locale\`, else pt-BR`,
  buildRail: (ctx) => {
    // A read-only agent has no rail to reach: the stub answers offline, whatever key the environment carries.
    const killAfterDispatch = ctx.envVar("KILL_AFTER_DISPATCH") === "1" ? { afterDispatch: () => process.exit(137) } : {};
    const refuse = ctx.envVar("STUB_REFUSE") ? { refusePayees: ctx.envVar("STUB_REFUSE")!.split(",").map((p) => p.trim()).filter(Boolean) } : {};
    return {
      rail: new StubRail(ctx.store, { ...(ctx.now ? { clock: ctx.now } : {}), ...killAfterDispatch, ...refuse, ...(ctx.stubRail ?? {}) }),
      mandate: ctx.mandate ?? loadMandate(ctx.manifest.resolvePath(ctx.manifest.manifest.mandate_schema)),
    };
  },
  handlers: () => ({}),
  describeExecution: (execution, setup) => describePayment(execution, setup),
  oneShotPayload: ({ setup: s, reply, toolCalls, executions }) => ({
    run_id: s.runId,
    agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
    mode: s.mode,
    rail: s.railKind,
    mandate_id: s.mandate.id,
    actor: s.engine.agentActor,
    reply,
    tool_calls: toolCalls,
    executions: executions.map((e: Execution) => ({
      id: e.id,
      state: e.state,
      reason: e.reason ?? null,
      rail_error: railErrorOf(e),
      escalation: e.escalation ?? null,
      total_minor: e.total,
      items: e.items.map((i) => ({ beneficiary: i.beneficiary, amount_minor: i.amount })),
      approval_id: e.approval_id ?? null,
      receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
      replayed: isReplayedSettlement(e),
    })),
    receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
    bundle_dir: relative(process.cwd(), s.bundle.dir),
  }),
};
