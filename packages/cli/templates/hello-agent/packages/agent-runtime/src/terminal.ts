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
import type { AgentRuntime, BatchGesture, BatchPresentation, ChargeInstrument, Execution } from "@codespar/agent-core";
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
  /**
   * Where the lines for the counterparty go (the conversation); `say` is the
   * operator's console. `about` is the execution whose OUTCOME the line tells,
   * so a channel can tie a failed delivery of it back to that outcome.
   */
  tell?: ((line: string, about?: Execution) => void) | undefined;
  /**
   * How a payable receivable is put in front of the counterparty. Defaults to
   * the kit's own, which writes lines to a console. A channel overrides it,
   * because a QR on WhatsApp is an image and the copy-and-paste is its own
   * message, and neither of those is a line of text.
   */
  presentInstrument?: ((execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, tell: (line: string) => void) => void | Promise<void>) | undefined;
  /**
   * The gestures taken on whole batches in this session, by batch ref. When a
   * line of a batch arrives and its ref is here, the line is decided by the
   * gesture instead of by a question; see `presentBatch`.
   */
  gestures?: BatchGestures | undefined;
}

/** One gesture per batch ref: the list it was taken on, and the positions vetoed. */
export type BatchGestures = Map<string, BatchGestureRecord>;
type BatchGestureRecord = { batch_hash: string; count: number; vetoed: Set<number> };

export function describeExecution(execution: Execution, setup: Setup): string[] {
  return setup.kit.describeExecution(execution, setup);
}

/** The one message per outcome, recorded so a duplicate event never sends it twice. */
export function announceOutcome(execution: Execution, setup: Setup, tell: (line: string) => void): boolean {
  return setup.kit.announceOutcome?.(execution, setup, tell) ?? false;
}

/** The kit's follow-up to an outcome. Never throws: what follows a paid order cannot un-pay it. */
export async function followUp(execution: Execution, setup: Setup, say: (line: string) => void): Promise<void> {
  if (!setup.kit.followUp) return;
  try {
    await setup.kit.followUp(execution, setup, say);
  } catch (err) {
    say(`  follow-up of ${execution.id} failed and changed nothing about it: ${err instanceof Error ? err.message : String(err)}`);
  }
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
    const gesture = options.decision === undefined && current.batch ? options.gestures?.get(current.batch.ref) : undefined;
    if (gesture) {
      current = decideByGesture(current, gesture, setup, approver);
    } else {
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
    }
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
  }

  // An agent that issues on request (`executeOnApproval: false`) leaves the approved execution for its own tool to issue.
  if (current.state === "approved" && setup.kit.executeOnApproval !== false) {
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
    const told = current;
    announceOutcome(told, setup, (line) => tell(line, told));
    await followUp(current, setup, say);
  }
  return current;
}

/**
 * A line of a batch the person already decided on as a list. The gesture
 * approves or vetoes a POSITION in ONE list: a line that names another list
 * under the same ref is not covered by it, and "todas" must not become a yes
 * to a list nobody was shown. `approve` still runs the policy and still mints
 * this line's own artifact, which carries the `batch_hash` the gesture was
 * taken on — that is what makes the gesture attested rather than asserted.
 */
function decideByGesture(execution: Execution, gesture: BatchGestureRecord, setup: Setup, approver: TerminalOptions["approver"]): Execution {
  const engine = setup.engine;
  const { batch_hash, index, count } = execution.batch!;
  if (batch_hash !== gesture.batch_hash || count !== gesture.count) {
    return engine.deny(execution.id, approver, `the list changed after the gesture: it was taken on ${gesture.count} line(s) hashing to ${gesture.batch_hash}, and this line belongs to ${count} hashing to ${batch_hash}`);
  }
  if (gesture.vetoed.has(index)) return engine.deny(execution.id, approver, `vetoed in the batch gesture (line ${index + 1} of ${count})`);
  return engine.approve(execution.id, approver);
}

/**
 * What the person answered to a whole list, or `undefined` when the answer
 * cannot be read as one. Lines are numbered from 1, as they were shown.
 * "todas" / "all", "todas exceto 3,7" / "all except 3,7", and "nenhuma" /
 * "none" (also an empty answer: the default is no, as it is per line). A
 * number outside the list is unreadable rather than ignored, because a typo
 * that silently vetoed nothing would pay the line the person meant to stop.
 */
export function parseBatchGesture(answer: string, count: number): { vetoed: number[] } | undefined {
  const text = answer.trim().toLowerCase();
  const all = Array.from({ length: count }, (_, i) => i);
  if (text === "" || text === "nenhuma" || text === "none" || text === "n" || text === "nao") return { vetoed: all };
  if (text === "todas" || text === "all") return { vetoed: [] };
  const except = /^(?:todas|all)\s+(?:exceto|except)\s+([\d\s,]+)$/.exec(text);
  if (!except) return undefined;
  const numbers = except[1]!.split(/[\s,]+/).filter(Boolean).map(Number);
  if (numbers.length === 0 || numbers.some((n) => !Number.isInteger(n) || n < 1 || n > count)) return undefined;
  return { vetoed: [...new Set(numbers.map((n) => n - 1))].sort((a, b) => a - b) };
}

/**
 * Section 3, for a list: the person sees every line, the total and the hash
 * prefix, and answers once. What they answer is recorded in the bundle as a
 * `batch.gesture` event and kept for the lines that follow; each line is then
 * decided by `decideByGesture` when it arrives, and each one it approves mints
 * its own artifact as before.
 */
export async function presentBatch(batch: BatchPresentation, options: TerminalOptions & { gestures: BatchGestures }): Promise<BatchGesture> {
  const { setup, approver } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const ask = options.ask ?? defaultAsk;
  say(`  lote ${batch.ref} — ${batch.label}: ${batch.count} linha(s), total ${batch.total}, batch_hash ${batch.batch_hash.slice(0, 19)}…`);
  for (const line of batch.lines) {
    const note =
      line.status === "already_settled"
        ? " (ja paga; nao roda de novo)"
        : line.status === "in_progress"
          ? " (em andamento; nao roda de novo)"
          : line.status === "attempt_id_conflict"
            ? " (tentativa presa a outro pagamento; nao roda de novo)"
            : "";
    say(`    ${line.index + 1}. ${line.beneficiary}: ${line.amount}${note}`);
  }
  let parsed: { vetoed: number[] } | undefined;
  while (!parsed) {
    parsed = parseBatchGesture(await ask("  Aprovar a lista? [todas / todas exceto 3,7 / nenhuma] "), batch.count);
    if (!parsed) say(`  nao entendi; responda todas, todas exceto <numeros de 1 a ${batch.count}> ou nenhuma`);
  }
  const vetoed = new Set(parsed.vetoed);
  const gesture: BatchGesture = { batch_hash: batch.batch_hash, approved: batch.lines.map((l) => l.index).filter((i) => !vetoed.has(i)), vetoed: parsed.vetoed };
  options.gestures.set(batch.ref, { batch_hash: batch.batch_hash, count: batch.count, vetoed });
  setup.engine.note("batch.gesture", null, { batch_ref: batch.ref, batch_hash: batch.batch_hash, count: batch.count, total_minor: batch.total_minor, approved: gesture.approved, vetoed: gesture.vetoed, approver: { type: "human", id: approver.id, channel: approver.channel } });
  say(`  -> lista ${gesture.vetoed.length === 0 ? "aprovada inteira" : gesture.approved.length === 0 ? "negada inteira" : `aprovada exceto ${gesture.vetoed.map((i) => i + 1).join(", ")}`}`);
  return gesture;
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
  // Interactive only: a person at the keyboard can decide a list in one go. The one-shot and the scenario runner pass one decision to every line and never reach this.
  const gestures: BatchGestures = new Map();
  const withGestures = { ...options, gestures };
  const loop = setup.makeLoop(options.runtime, (execution) => handleExecution(execution, withGestures), (batch) => presentBatch(batch, withGestures));
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
