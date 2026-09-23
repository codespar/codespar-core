/**
 * How the cycle closes without a webhook: the kit LOOKS at the receivable
 * (`GET /v1/charges/{id}` through the rail's `lookup`, the stub's fixture
 * offline) until the payer acted or the wait ran out. Each look is a
 * `reconcile`, which is read-only on the rail and never re-issues. The
 * instrument (QR, copy-and-paste, bank line) is presented the first time a
 * look finds it payable; the debtor is told the outcome once, whatever the
 * number of looks or events that carried it.
 */
import type { ChargeInstrument, Execution, ExecutionEngine } from "@codespar/agent-core";
import type { SandboxPayer } from "./setup.js";

export interface PollHooks {
  /** A receivable became payable: show the payer how to pay. Called once per instalment. */
  onInstrument?: (execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument) => void;
  /** The execution reached a terminal state. Called once. */
  onClosed?: (execution: Execution) => void;
  /** Called before each look after the first. */
  onWait?: (execution: Execution, round: number) => void;
}

export interface PollOptions extends PollHooks {
  intervalMs: number;
  /** Wall-clock budget for the wait. */
  timeoutMs: number;
  /** Cap on looks, for a zero-interval (stub) loop: the fixture payer acts within two looks; a third proves nothing changes. */
  maxRounds?: number;
  /** When set, the payer plays as soon as every instalment is payable (a scenario, `--simulate-payer`). */
  payer?: SandboxPayer | undefined;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface PollResult {
  execution: Execution;
  rounds: number;
  /** Seconds from the first look to the terminal state, or to the end of the wait. */
  seconds: number;
  timed_out: boolean;
  payer_calls: string[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Presents each instalment once, records `message.debtor` once per outcome,
 * and returns when the execution is terminal or the wait is over. Safe to
 * call again on the same execution (a restart): what was already shown is
 * remembered in the state.db cursor table, not in memory.
 */
export async function pollUntilClosed(engine: ExecutionEngine, executionId: string, options: PollOptions): Promise<PollResult> {
  const clock = options.clock ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const startedWall = Date.now();
  const started = clock().getTime();
  const maxRounds = options.maxRounds ?? (options.intervalMs === 0 ? 3 : Number.POSITIVE_INFINITY);
  const payerCalls: string[] = [];
  let execution = engine.get(executionId);
  if (!execution) throw new Error(`unknown execution ${executionId}`);
  let rounds = 0;
  let paidRequested = false;

  const present = (e: Execution) => {
    for (const outcome of e.outcomes) {
      if (outcome.status !== "accepted" || !outcome.instrument?.payable || !outcome.transaction_id) continue;
      if (!engine.markShown(e.id, outcome.attempt_id)) continue;
      options.onInstrument?.(e, outcome.index + 1, outcome.transaction_id, outcome.instrument);
    }
  };

  present(execution);
  while (execution.state === "executing") {
    if (rounds > 0) {
      // A zero-interval loop (the stub) is bounded by looks; a real one by the wall clock.
      if (rounds >= maxRounds || (options.intervalMs > 0 && Date.now() - startedWall >= options.timeoutMs)) break;
      options.onWait?.(execution, rounds);
      if (options.intervalMs > 0) await sleep(options.intervalMs);
    }
    rounds += 1;
    execution = await engine.reconcile(execution.id);
    present(execution);
    const payable = execution.outcomes.filter((o) => o.status === "accepted" && o.instrument?.payable && o.transaction_id);
    if (options.payer && !paidRequested && execution.state === "executing" && payable.length > 0 && payable.length === execution.outcomes.filter((o) => o.status === "accepted").length) {
      paidRequested = true;
      for (const outcome of payable) {
        const result = await options.payer.pay(outcome.transaction_id!, outcome.attempt_id);
        payerCalls.push(result.detail);
        engine.note("sandbox_payer", execution.id, { charge_id: outcome.transaction_id, ok: result.ok, detail: result.detail });
      }
    }
  }
  if (execution.state !== "executing") options.onClosed?.(execution);
  return { execution, rounds, seconds: Math.round(((clock().getTime() - started) / 1000) * 10) / 10, timed_out: execution.state === "executing", payer_calls: payerCalls };
}
