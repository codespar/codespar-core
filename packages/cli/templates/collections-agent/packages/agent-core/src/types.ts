/**
 * Shared shapes of the core. Amounts are always integer minor units (BRL
 * cents). Timestamps are ISO 8601 strings so they survive SQLite and JSON
 * unchanged.
 */

export type ApprovalMode = "human" | "mandate";

/** Section 4.5: who acted. Every API call and every receipt carries one. */
export type Actor =
  | { type: "agent"; agent: string; on_behalf_of: string }
  | { type: "human"; id: string; channel: string };

/** One line of an execution: a payee and an amount, resolved by the core. */
export interface ExecutionItem {
  /** The alias the model used (`escola`), when it used one. */
  alias?: string;
  /** Display name from the mandate's named payees, when known. */
  beneficiary: string;
  /** The pinned payee key (a Pix key for `pix-key` mandates). */
  payee: string;
  amount: number;
  currency: string;
  description?: string;
  /** A receivable's due date (`YYYY-MM-DD`). Part of the `items_hash` when present: moving it after approval is a different charge. */
  due_date?: string;
}

/**
 * The SET a line belongs to, when the line is one execution of a batch.
 *
 * A batch of N lines is N executions, each attested by its own `items_hash`.
 * That leaves the list itself unattested: a person who approved four lines
 * while the agent ran three leaves a bundle that does not say a fourth
 * existed. `batch_hash` binds the set — computed once over the ordered lines
 * at the moment the list is presented for approval, and carried by every
 * artifact of that batch together with the line's own position in it.
 *
 * Absent on an execution that is not part of a batch, and an artifact
 * without it is the artifact of section 4.2 unchanged, byte for byte: the
 * field is omitted rather than null, so the canonical payload it signs is
 * the same payload it signed before this existed.
 */
export interface ExecutionBatch {
  /** The batch's reference, as the kit names it (`folha-2026-10`). */
  ref: string;
  /** `batchHash` over the batch's ordered lines, as they were presented. */
  batch_hash: string;
  /** This line's position in that ordered list, counting from 0. */
  index: number;
  /** How many lines the presented list held. */
  count: number;
}

/** The trigger of section 4.4 that sent a `mandate` execution to a human. */
export type EscalationTrigger = "amount" | "new_beneficiary" | "outside_hours";

/** Stable reasons a transition can carry. They are the readable-failure contract. */
export type ExecutionReason =
  | "mandate_revoked"
  | "mandate_paused"
  | "mandate_expired"
  | "mandate_status_unavailable"
  | "org_paused"
  | "beneficiary_not_allowed"
  | "per_tx_cap_exceeded"
  | "window_cap_exceeded"
  | "approval_expired"
  | "items_hash_mismatch"
  | "mandate_changed"
  | "denied_by_approver"
  | "rail_failed"
  | "rail_uncertain"
  | "tool_not_allowed"
  | "model_total_mismatch"
  | "outside_hours"
  | "escalated"
  /** The agent's own envelope (guardrails) refused what the model proposed: a discount, an instalment count or a due date outside it. */
  | "outside_envelope"
  /** A receivable was issued and the rail is waiting for the payer; the execution stays `executing` until `commerce.charge.*` closes it. */
  | "awaiting_settlement"
  | "charge_expired"
  | "charge_cancelled";

export interface MandateRef {
  id: string;
  version: number;
}

/** Section 4.2. */
export interface ApprovalArtifact {
  approval_id: string;
  execution_id: string;
  mode: ApprovalMode;
  approver:
    | { type: "person"; id: string; channel: string }
    | { type: "mandate"; id: string };
  approved_at: string;
  expires_at: string;
  mandate: MandateRef;
  items: ExecutionItem[];
  items_hash: string;
  /** Present when this execution is one line of a batch: what binds the SET this line was approved inside. */
  batch?: ExecutionBatch;
  /** Present when a section 4.4 trigger sent the execution to a human first. */
  escalation?: { trigger: EscalationTrigger; detail: string };
  actor: Actor;
  signature: { alg: "HMAC-SHA256"; key_id: string; value: string };
}

export interface ItemOutcome {
  index: number;
  attempt_id: string;
  /** `accepted`: the rail took the attempt and the outcome comes later (a receivable waiting for its payer). Not terminal. */
  status: "settled" | "failed" | "accepted";
  receipt_id?: string;
  transaction_id?: string;
  /** The rail's code on a failed outcome (`charge_expired`, `charge_cancelled`, a provider code). */
  code?: string;
  error?: string;
  /** What the payer is shown for an accepted receivable, as the rail handed it back. Presentation only; nothing here decides money. */
  instrument?: ChargeInstrument;
}

/** The payable legs of a receivable. Null until the issuer registers the instrument (a cobranca com vencimento answers PROCESSING first). */
export interface ChargeInstrument {
  payable: boolean;
  pix_copy_paste: string | null;
  boleto_bank_line: string | null;
  boleto_bar_code: string | null;
  due_date: string | null;
  /** The issuer's normalized state as last read: PROCESSING, PENDING, CONFIRMED, EXPIRED, CANCELLED. */
  status: string;
}
