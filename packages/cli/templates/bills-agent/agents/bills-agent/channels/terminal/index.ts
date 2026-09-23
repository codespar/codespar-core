/**
 * The terminal channel: what `npm start` opens. No account, no server. It
 * shows what the core decided, asks the person when an execution is
 * awaiting approval, and prints where the receipt landed.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { relative } from "node:path";
import type { Execution } from "@codespar/agent-core";
import { formatBRL } from "../../src/bills.js";
import type { Setup } from "../../src/setup.js";

export interface TerminalOptions {
  setup: Setup;
  approver: { id: string; channel: string };
  /** Non-interactive decision for `--input`: approve, deny, or leave it awaiting. */
  decision?: "approve" | "deny" | "none";
  say?: (line: string) => void;
  ask?: (question: string) => Promise<string>;
}

export function describeExecution(execution: Execution, setup: Setup): string[] {
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
}

/** Decides an `awaiting_approval` execution and runs an `approved` one. Returns the final execution of this pass. */
export async function handleExecution(execution: Execution, options: TerminalOptions): Promise<Execution> {
  const { setup, approver } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const engine = setup.engine;

  for (const line of describeExecution(execution, setup)) say(line);

  let current = execution;
  if (current.state === "awaiting_approval") {
    let decision = options.decision;
    if (!decision) {
      if (current.blocking_reasons.length > 0) {
        say("  (o unico desfecho possivel e negar; aperte Enter)");
      }
      const ask = options.ask ?? defaultAsk;
      const answer = (await ask("  Aprovar este pagamento? [s/N] ")).trim().toLowerCase();
      decision = answer === "s" || answer === "sim" || answer === "y" || answer === "yes" ? "approve" : "deny";
    }
    if (decision === "approve") current = engine.approve(current.id, approver);
    else if (decision === "deny") current = engine.deny(current.id, approver);
    else {
      say("  deixado em awaiting_approval (rode de novo com --approve ou --deny)");
      return current;
    }
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
  }

  if (current.state === "approved") {
    current = await engine.execute(current.id);
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
    for (const outcome of current.outcomes) {
      if (outcome.receipt_id) say(`  recibo: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
    }
    if (current.state === "executing") say("  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita o pagamento)");
  }
  return current;
}

let rl: ReturnType<typeof createInterface> | undefined;

export function defaultAsk(question: string): Promise<string> {
  rl ??= createInterface({ input: stdin, output: stderr });
  return rl.question(question);
}

export function closeTerminal(): void {
  rl?.close();
  rl = undefined;
}

export async function interactive(options: TerminalOptions & { runtime: import("@codespar/agent-core").AgentRuntime }): Promise<void> {
  const { setup } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const loop = setup.makeLoop(options.runtime, (execution) => handleExecution(execution, options));
  say(`bills-agent ${setup.manifest.manifest.version} — approval: ${setup.mode} — trilho: ${setup.railKind} — mandato ${setup.mandate.id}`);
  say(`run ${setup.runId} — bundle em ${relative(process.cwd(), setup.bundle.dir)}`);
  say('Diga o que pagar ("pague a escola de outubro"). Ctrl+D ou "sair" encerra.');
  for (;;) {
    let text: string;
    try {
      text = await defaultAsk("> ");
    } catch {
      break;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (["sair", "exit", "quit"].includes(trimmed.toLowerCase())) break;
    const result = await loop.turn(trimmed);
    stdout.write(result.reply + "\n");
  }
  closeTerminal();
}
