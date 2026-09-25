/**
 * Section 4.1: the execution as a closed state machine.
 *
 * The transition table is a type. `transition()` only accepts a target that
 * the table lists for the current state, so a transition outside the table
 * does not compile; the runtime check below refuses the same pair when the
 * types were bypassed (a cast, a row read back from SQLite).
 */
import type { Actor, ApprovalMode, EscalationTrigger, ExecutionBatch, ExecutionItem, ExecutionReason, ItemOutcome, MandateRef } from "./types.js";

export type ExecutionState =
  | "drafted"
  | "awaiting_approval"
  | "approved"
  | "executing"
  | "settled"
  | "failed"
  | "denied"
  | "expired";

/**
 * The table of section 4.1, plus the two exits section 4.7 adds (revocation
 * from `drafted` / `approved`) and the return section 4.2 adds (`approved`
 * back to `awaiting_approval` when the list changed after approval).
 */
export type TransitionTable = {
  drafted: "awaiting_approval" | "approved" | "denied" | "expired";
  awaiting_approval: "approved" | "denied" | "expired";
  approved: "executing" | "awaiting_approval" | "denied" | "expired";
  executing: "settled" | "failed";
  settled: never;
  failed: never;
  denied: never;
  expired: never;
};

export type NextState<S extends ExecutionState> = TransitionTable[S];

export const TRANSITIONS: { readonly [S in ExecutionState]: readonly TransitionTable[S][] } = {
  drafted: ["awaiting_approval", "approved", "denied", "expired"],
  awaiting_approval: ["approved", "denied", "expired"],
  approved: ["executing", "awaiting_approval", "denied", "expired"],
  executing: ["settled", "failed"],
  settled: [],
  failed: [],
  denied: [],
  expired: [],
};

export const TERMINAL_STATES: readonly ExecutionState[] = ["settled", "failed", "denied", "expired"];

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface TransitionRecord {
  from: ExecutionState;
  to: ExecutionState;
  at: string;
  reason?: ExecutionReason;
  detail?: string;
  actor: Actor;
}

export interface Execution<S extends ExecutionState = ExecutionState> {
  id: string;
  run_id: string;
  state: S;
  mode: ApprovalMode;
  /** Who created the execution: always the agent acting for someone. */
  actor: Actor;
  items: ExecutionItem[];
  /** Computed by the core, never by the model. */
  total: number;
  currency: string;
  /** What the model claimed the total was, when it claimed one. Recorded, never used. */
  model_claimed_total?: number;
  items_hash: string;
  /** Present when this execution is one line of a batch: the set it was presented inside, and where in it. */
  batch?: ExecutionBatch;
  mandate: MandateRef;
  /** Written once, before the rail is called. Retrying reuses it. */
  idempotency_key: string;
  approval_id?: string;
  escalation?: { trigger: EscalationTrigger; detail: string };
  /** Reasons the core will refuse to approve, even if a human says yes. */
  blocking_reasons: ExecutionReason[];
  reason?: ExecutionReason;
  detail?: string;
  outcomes: ItemOutcome[];
  history: TransitionRecord[];
  created_at: string;
  updated_at: string;
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly executionId: string,
    readonly from: ExecutionState,
    readonly to: ExecutionState,
  ) {
    super(`illegal transition ${from} -> ${to} on ${executionId}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return (TRANSITIONS[from] as readonly ExecutionState[]).includes(to);
}

export interface TransitionInput {
  at: string;
  actor: Actor;
  reason?: ExecutionReason;
  detail?: string;
}

/**
 * Move an execution to a state the table allows. Returns a new object with
 * the transition appended to `history`; the caller persists it.
 */
export function transition<S extends ExecutionState, T extends NextState<S>>(
  execution: Execution<S>,
  to: T,
  input: TransitionInput,
): Execution<T> {
  if (!canTransition(execution.state, to)) {
    throw new IllegalTransitionError(execution.id, execution.state, to);
  }
  const record: TransitionRecord = {
    from: execution.state,
    to,
    at: input.at,
    actor: input.actor,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
  };
  // `reason`/`detail` describe the LATEST transition; a step without one clears what the previous step left.
  const { reason: _reason, detail: _detail, ...rest } = execution;
  return {
    ...rest,
    state: to,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.detail ? { detail: input.detail } : {}),
    history: [...execution.history, record],
    updated_at: input.at,
  } as Execution<T>;
}
