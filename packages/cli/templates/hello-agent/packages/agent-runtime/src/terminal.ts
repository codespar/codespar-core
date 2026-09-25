/**
 * The terminal channel: what `codespar-agent start` opens. No account, no
 * server. It shows what the core decided, asks the person when an execution
 * is awaiting approval, and prints where the sealed outcome landed. The
 * words are the agent's (`kit.labels`, `kit.describeExecution`); the order
 * of the gates is the runner's and is the same for every agent.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { relative } from "node:path";
import type { AgentRuntime, ChargeInstrument, Execution } from "@codespar/agent-core";
import { pollUntilClosed, type PollResult } from "./poll.js";
import type { Setup } from "./setup.js";

export interface TerminalOptions {
  setup: Setup;
  approver: { id: string; channel: string };
  /** Non-interactive decision for a one-shot: approve, deny, or leave it awaiting. */
  decision?: "approve" | "deny" | "none";
  /** `await-payer` only: seconds to wait for the payer after issuing. */
  waitSeconds?: number | undefined;
  /** `await-payer` only: let the sandbox payer act once the receivable is payable. */
  simulatePayer?: boolean | undefined;
  say?: ((line: string) => void) | undefined;
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Where the lines for the counterparty go (the conversation); `say` is the operator's console. */
  tell?: ((line: string) => void) | undefined;
  /**
   * How a payable receivable is put in front of the counterparty. Defaults to
   * the kit's own, which writes lines to a console. A channel overrides it,
   * because a QR on WhatsApp is an image and the copy-and-paste is its own
   * message, and neither of those is a line of text.
   */
  presentInstrument?: ((execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, tell: (line: string) => void) => void | Promise<void>) | undefined;
}

export function describeExecution(execution: Execution, setup: Setup): string[] {
  return setup.kit.describeExecution(execution, setup);
}

/** The one message per outcome, recorded so a duplicate event never sends it twice. */
export function announceOutcome(execution: Execution, setup: Setup, tell: (line: string) => void): boolean {
  return setup.kit.announceOutcome?.(execution, setup, tell) ?? false;
}

function receiptLines(execution: Execution, setup: Setup, say: (line: string) => void): void {
  for (const outcome of execution.outcomes) {
    if (outcome.receipt_id) say(`  ${setup.kit.labels.receiptWord}: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
  }
}

/** Decides an `awaiting_approval` execution and runs an `approved` one. Returns the final execution of this pass. */
export async function handleExecution(execution: Execution, options: TerminalOptions): Promise<Execution> {
  const { setup, approver } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const tell = options.tell ?? ((l: string) => stdout.write(l + "\n"));
  const labels = setup.kit.labels;
  const engine = setup.engine;

  for (const line of describeExecution(execution, setup)) say(line);

  let current = execution;
  if (current.state === "awaiting_approval") {
    let decision = options.decision;
    if (!decision) {
      if (current.blocking_reasons.length > 0) say("  (o unico desfecho possivel e negar; aperte Enter)");
      const ask = options.ask ?? defaultAsk;
      const answer = (await ask(labels.approveQuestion)).trim().toLowerCase();
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
    if (setup.settlement === "immediate") {
      receiptLines(current, setup, say);
      if (current.state === "executing") say(labels.uncertainDispatch);
    }
  }

  if (setup.settlement === "await-payer") {
    if (current.state === "executing" && current.reason === "awaiting_settlement") {
      const result = await waitForPayer(current.id, options);
      current = result.execution;
      say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""} apos ${result.rounds} consulta(s), ${result.seconds}s${result.timed_out ? " (tempo esgotado; `npm run poll` continua de onde parou)" : ""}`);
      receiptLines(current, setup, say);
    } else if (current.state === "executing") {
      say(labels.uncertainDispatch);
    }
    announceOutcome(current, setup, tell);
  }
  return current;
}

export async function waitForPayer(executionId: string, options: TerminalOptions): Promise<PollResult> {
  const { setup } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const tell = options.tell ?? ((l: string) => stdout.write(l + "\n"));
  const waitSeconds = options.waitSeconds ?? (setup.railKind === "api" ? 60 : 0);
  return pollUntilClosed(setup.engine, executionId, {
    intervalMs: setup.pollIntervalMs,
    timeoutMs: waitSeconds * 1000,
    payer: options.simulatePayer ? setup.payer : undefined,
    onInstrument: (e, n, id, instrument) => (options.presentInstrument ?? setup.kit.presentInstrument)?.(e, n, id, instrument, tell),
    onWait: (_e, round) => {
      const line = setup.kit.labels.waitingForPayer?.(round);
      if (setup.railKind === "api" && line !== undefined && round % 5 === 0) say(line);
    },
  });
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

export async function interactive(options: TerminalOptions & { runtime: AgentRuntime }): Promise<void> {
  const { setup } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const labels = setup.kit.labels;
  const loop = setup.makeLoop(options.runtime, (execution) => handleExecution(execution, options));
  say(`${setup.manifest.manifest.name} ${setup.manifest.manifest.version} — approval: ${setup.mode} — trilho: ${setup.railKind} — ${labels.mandateWord} ${setup.mandate.id}`);
  say(`run ${setup.runId} — bundle em ${relative(process.cwd(), setup.bundle.dir)}`);
  say(labels.intro);
  for (;;) {
    let text: string;
    try {
      text = await defaultAsk(labels.prompt);
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
