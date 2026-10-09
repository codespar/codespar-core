/**
 * The terminal channel: what `codespar-agent start` opens. No account, no
 * server. It shows what the core decided, asks the person when an execution
 * is awaiting approval, and prints where the sealed outcome landed. The
 * words are the agent's (`kit.strings`, `kit.describeExecution`) and the
 * shared ones (`CORE_STRINGS`), in the run's locale; the order of the gates
 * is the runner's and is the same for every agent, and so is what an answer
 * decides: the parsers below read both languages whatever the locale.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { relative } from "node:path";
import { formatBRL, railErrorOf, type AgentRuntime, type BatchGesture, type BatchPresentation, type ChargeInstrument, type Execution, type NotRunLine } from "@codespar/agent-core";
import { pollUntilClosed, type PollResult } from "./poll.js";
import { draftRefusals, refusalLine, sayOutcome } from "./outcome.js";
import { inLocaleOf, type Setup } from "./setup.js";

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
    if (outcome.receipt_id) say(`  ${setup.strings.receiptWord}: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
  }
}

/** Decides an `awaiting_approval` execution and runs an `approved` one. Returns the final execution of this pass. */
export async function handleExecution(execution: Execution, options: TerminalOptions): Promise<Execution> {
  const { setup, approver } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const tell = options.tell ?? ((l: string) => stdout.write(l + "\n"));
  const words = setup.strings;
  const text = setup.coreStrings;
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
        if (current.blocking_reasons.length > 0) say(text.onlyDeny);
        const ask = options.ask ?? defaultAsk;
        decision = parseApproval(await ask(words.approveQuestion));
      }
      if (decision === "approve") current = engine.approve(current.id, approver);
      else if (decision === "deny") current = engine.deny(current.id, approver);
      else {
        say(text.leftAwaiting);
        return current;
      }
    }
    say(transitionLine(current));
  }

  // An agent that issues on request (`executeOnApproval: false`) leaves the approved execution for its own tool to issue.
  if (current.state === "approved" && setup.kit.executeOnApproval !== false) {
    current = await engine.execute(current.id);
    say(transitionLine(current));
    if (setup.settlement === "immediate") {
      receiptLines(current, setup, say);
      if (current.state === "executing") say(words.uncertainDispatch);
    }
  }

  if (setup.settlement === "await-payer") {
    // The counterparty is spoken to in the locale of the run that proposed this execution (`npm run approve` is a later command); the operator's lines stay in this one's.
    const counterparty = inLocaleOf(setup, current);
    if (current.state === "executing" && current.reason === "awaiting_settlement") {
      const result = await waitForPayer(current.id, { ...options, setup: counterparty });
      current = result.execution;
      say(`${transitionLine(current)}${text.afterLooks(result.rounds, result.seconds, result.timed_out)}`);
      receiptLines(current, setup, say);
    } else if (current.state === "executing") {
      say(words.uncertainDispatch);
    }
    const told = current;
    announceOutcome(told, counterparty, (line) => tell(line, told));
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
 * What the person answered to the per-line question. Yes is s, sim, y or yes,
 * in any locale; anything else is no, which is the default the `[s/N]` and
 * `[y/N]` prompts show.
 */
export function parseApproval(answer: string): "approve" | "deny" {
  const text = answer.trim().toLowerCase();
  return text === "s" || text === "sim" || text === "y" || text === "yes" ? "approve" : "deny";
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
  const text = setup.coreStrings;
  // The amounts are formatted here from their minor units, in the run's locale; the presentation's own strings are the model's.
  say(text.batchHeader(batch.ref, batch.label, batch.count, formatBRL(batch.total_minor, setup.locale), batch.batch_hash.slice(0, 19)));
  for (const line of batch.lines) {
    const note =
      line.status === "already_settled"
        ? text.batchAlreadySettled
        : line.status === "in_progress"
          ? text.batchInProgress
          : line.status === "attempt_id_conflict"
            ? text.batchAttemptConflict
            : "";
    say(`    ${line.index + 1}. ${line.beneficiary}: ${formatBRL(line.amount_minor, setup.locale)}${note}`);
  }
  let parsed: { vetoed: number[] } | undefined;
  while (!parsed) {
    parsed = parseBatchGesture(await ask(text.batchQuestion), batch.count);
    if (!parsed) say(text.batchUnreadable(batch.count));
  }
  const vetoed = new Set(parsed.vetoed);
  const gesture: BatchGesture = { batch_hash: batch.batch_hash, approved: batch.lines.map((l) => l.index).filter((i) => !vetoed.has(i)), vetoed: parsed.vetoed };
  options.gestures.set(batch.ref, { batch_hash: batch.batch_hash, count: batch.count, vetoed });
  setup.engine.note("batch.gesture", null, { batch_ref: batch.ref, batch_hash: batch.batch_hash, count: batch.count, total_minor: batch.total_minor, approved: gesture.approved, vetoed: gesture.vetoed, approver: { type: "human", id: approver.id, channel: approver.channel } });
  say(gesture.vetoed.length === 0 ? text.batchApprovedAll : gesture.approved.length === 0 ? text.batchDeniedAll : text.batchApprovedExcept(gesture.vetoed.map((i) => i + 1).join(", ")));
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
    onInstrument: (e, n, id, instrument) => (options.presentInstrument ?? setup.kit.presentInstrument)?.(e, n, id, instrument, tell, setup.locale),
    onWait: (_e, round) => {
      const line = setup.strings.waitingForPayer?.(round);
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
  const words = setup.strings;
  // Interactive only: a person at the keyboard can decide a list in one go. The one-shot and the scenario runner pass one decision to every line and never reach this.
  const gestures: BatchGestures = new Map();
  const withGestures = { ...options, gestures };
  const loop = setup.makeLoop(options.runtime, (execution) => handleExecution(execution, withGestures), (batch) => presentBatch(batch, withGestures));
  say(setup.coreStrings.banner(setup.manifest.manifest.name, setup.manifest.manifest.version, setup.mode, setup.railKind, words.mandateWord, setup.mandate.id));
  say(setup.coreStrings.bundleAt(setup.runId, relative(process.cwd(), setup.bundle.dir)));
  say(words.intro);
  const notRun: NotRunLine[] = [];
  let refusalsSaid = 0;
  for (;;) {
    let text: string;
    try {
      text = await defaultAsk(words.prompt);
    } catch {
      break;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (["sair", "exit", "quit"].includes(trimmed.toLowerCase())) break;
    const result = await loop.turn(trimmed);
    stdout.write(`${result.reply}\n`);
    // The line counts the run so far, and is said only after a turn that paid, tried to, or skipped a line: a greeting or a read moved nothing.
    notRun.push(...result.not_run);
    // A request refused before a draft: said with the engine's own reason, once, in the turn that met it.
    const refused = draftRefusals(setup.store, setup.runId).slice(refusalsSaid);
    refusalsSaid += refused.length;
    for (const refusal of refused) say(refusalLine(refusal));
    if (result.executions.length > 0 || result.not_run.length > 0 || refused.length > 0) sayOutcome(setup, notRun, (line) => stdout.write(`${line}\n`));
  }
  closeTerminal();
}

/**
 * `  -> failed (rail_failed): insufficient_funds — wallet cannot reserve the requested amount`.
 * The reason says which gate closed the execution; on a failure, or an answer
 * that left an attempt unknown, the rail's own code and message follow it,
 * verbatim, so the first failure explains itself (#50).
 */
export function transitionLine(execution: Execution): string {
  const failure = execution.state === "failed" || execution.state === "executing" ? railErrorOf(execution) : null;
  const answer = failure ? `: ${failure.code}${failure.message && failure.message !== failure.code ? ` — ${failure.message}` : ""}` : "";
  return `  -> ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}${answer}`;
}
