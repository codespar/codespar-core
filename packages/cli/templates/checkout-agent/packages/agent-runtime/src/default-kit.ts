/**
 * What an agent gets when it declares nothing: the stub payment rail over the
 * example mandate, the generic console words, and no tools. A read-only agent
 * spreads this and adds its handlers; a payer or a collector replaces the rail.
 */
import { StubRail, loadMandate, type Execution } from "@codespar/agent-core";
import { relative } from "node:path";
import type { AgentKit } from "./kit.js";

export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}R$ ${Math.floor(abs / 100).toLocaleString("pt-BR")},${String(abs % 100).padStart(2, "0")}`;
}

export const defaultKit: AgentKit = {
  settlement: "immediate",
  scenarioRail: "stub",
  labels: {
    defaultUser: "usr_terminal",
    evalUser: "usr_demo_titular",
    mandateWord: "mandato",
    receiptWord: "recibo",
    intro: 'Diga o que precisa. Ctrl+D ou "sair" encerra.',
    prompt: "> ",
    approveQuestion: "  Aprovar? [s/N] ",
    uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a operacao)",
    missingReceiptKind: "receipt_missing_locally",
    missingReceiptDetail: (receiptId, runId) => `receipt ${receiptId} is not in runs/${runId}/receipts`,
    stillExecuting: (e) => `${e.id}: still executing — ${e.detail}; nothing was re-sent`,
  },
  usage: (manifest) => `${manifest.manifest.name}
  npm start                              interactive terminal
  npm start -- --input "..."             one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>         run a scenario pack (see scenarios/)
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>  --json
         --now <ISO 8601>  pin the run to that instant; env CODESPAR_AGENT_NOW is the same thing`,
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
  describeExecution: (execution, setup) => {
    const lines: string[] = [];
    lines.push(`  execucao ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
    for (const item of execution.items) lines.push(`    - ${item.beneficiary}: ${formatMinor(item.amount)}${item.description ? ` — ${item.description}` : ""}`);
    lines.push(`    total (calculado pelo core): ${formatMinor(execution.total)}`);
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
    executions: executions.map((e: Execution) => ({
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
};
