/**
 * What a run did, counted from what the engine holds and not from what the
 * model said. A reply is the model's (or a recording's) and may claim a
 * payroll ran when every line was already paid or every line failed; this is
 * the line the terminal prints after it, and the one-shot's exit code.
 *
 * The unit is the payment, not the execution: an execution that paid three
 * bills and failed the fourth closes `failed`, and counts three settled and
 * one failed.
 */
import { isDeclinedReason, isTerminal, type CoreStrings, type Execution, type ExecutionEngine, type NotRunLine, type StateStore } from "@codespar/agent-core";

export interface RunOutcome {
  /** Payments this run settled. */
  settled: number;
  /** Payments the rail failed, executions that failed before any, and lines refused before a draft existed. */
  failed: number;
  /** Denied or expired, or closed by a declined reason (`isDeclinedReason`): somebody said no, or nobody answered or paid in time. */
  declined: number;
  /** Payments an earlier run already made: skipped here, or answered by the API with the earlier payment. */
  already_paid: number;
  /** Executions not yet terminal, plus lines an earlier execution still holds. */
  open: number;
}

/** A request the engine refused before a draft existed (`execution.refused_before_draft`): the gate's own reason and detail. */
export interface DraftRefusal {
  reason: string;
  detail: string;
}

/**
 * Every refusal before a draft the engine recorded for this run, in order,
 * for the sentence on the terminal and for `--json`. It is NOT what the count
 * is taken from: each tool reports its refused request through `onNotRun`,
 * and that is the one source of the count.
 */
export function draftRefusals(store: StateStore, runId: string): DraftRefusal[] {
  return store
    .listEvents({ run_id: runId })
    .filter((e) => e.type === "execution.refused_before_draft")
    .map((e) => {
      const payload = e.payload as { reason?: unknown; detail?: unknown };
      return { reason: String(payload.reason ?? "unknown"), detail: String(payload.detail ?? "") };
    });
}

export function refusalLine(refusal: DraftRefusal): string {
  return `  -> refused_before_draft (${refusal.reason}): ${refusal.detail}`;
}

export function runOutcome(executions: readonly Execution[], notRun: readonly NotRunLine[]): RunOutcome {
  const out: RunOutcome = { settled: 0, failed: 0, declined: 0, already_paid: 0, open: 0 };
  for (const e of executions) {
    if (!isTerminal(e.state)) out.open += 1;
    else if (e.state === "denied" || e.state === "expired") out.declined += 1;
    // Closed with no attempt on record: the execution is the one thing to count.
    else if (e.outcomes.length === 0) out[e.state === "settled" ? "settled" : isDeclinedReason(e.reason) ? "declined" : "failed"] += 1;
    else {
      for (const o of e.outcomes) {
        if (o.status === "settled") out[o.replayed === true ? "already_paid" : "settled"] += 1;
        else if (o.status === "failed") out[isDeclinedReason(o.code) ? "declined" : "failed"] += 1;
        else out.open += 1;
      }
    }
  }
  for (const line of notRun) {
    if (line.why === "already_settled") out.already_paid += 1;
    else if (line.why === "refused") out.failed += 1;
    else out.open += 1;
  }
  return out;
}

export function outcomeLine(text: CoreStrings, outcome: RunOutcome): string {
  return text.runOutcome(outcome.settled, outcome.failed, outcome.declined, outcome.already_paid, outcome.open);
}

/** The executions of one run as the engine holds them now, each once. */
export function runExecutions(engine: ExecutionEngine, runId: string): Execution[] {
  const byId = new Map<string, Execution>();
  for (const e of engine.list()) if (e.run_id === runId) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * The one place the terminal and the one-shot count a run: the engine's
 * executions of this run plus the lines that created none. The refusals
 * before a draft come back with it, to be said and listed. `say`, when given,
 * receives the count line.
 */
export function sayOutcome(
  source: { engine: ExecutionEngine; store: StateStore; runId: string; coreStrings: CoreStrings },
  notRun: readonly NotRunLine[],
  say?: (line: string) => void,
): { executions: Execution[]; refusals: DraftRefusal[]; outcome: RunOutcome; line: string } {
  const executions = runExecutions(source.engine, source.runId);
  const refusals = draftRefusals(source.store, source.runId);
  const outcome = runOutcome(executions, notRun);
  const line = outcomeLine(source.coreStrings, outcome);
  say?.(line);
  return { executions, refusals, outcome, line };
}

/**
 * The one-shot's exit code. 1 when a payment failed or a line was refused
 * before a draft, and it wins over 3: a run that failed something and left
 * something else `executing` is a failed run, and the line still counts what
 * is open. 3 when nothing failed and an execution OF THIS RUN was left
 * `executing`, whose outcome the rail did not say. 0 otherwise: settled,
 * already paid, still open, and also denied or expired, which are the agent
 * doing its job and are named on the line. A line an earlier run still holds
 * (`in_progress`) is open and exits 0: this run left nothing behind.
 */
export function outcomeExitCode(outcome: RunOutcome, executions: readonly Execution[] = []): 0 | 1 | 3 {
  if (outcome.failed > 0) return 1;
  return executions.some((e) => e.state === "executing") ? 3 : 0;
}
