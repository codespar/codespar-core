/**
 * The payment rail the core dispatches to once an execution is `executing`.
 * Two implementations: the CodeSpar sandbox through the API (needs a
 * `csk_test_` key) and a local stub persisted in state.db for CI and
 * scenarios. Both are idempotent on `attempt_id`: presenting the same
 * attempt again answers the earlier outcome instead of paying twice.
 */
import type { Actor, ChargeInstrument } from "./types.js";

export interface RailPayment {
  attempt_id: string;
  mandate_id: string;
  amount_minor: number;
  currency: string;
  payee: string;
  purpose: string;
  agent_id: string;
  description?: string;
  /** Display name of the counterparty (a receivable's debtor). The rail that issues a charge needs it; a payout rail ignores it. */
  beneficiary?: string;
  /** Due date of a receivable, `YYYY-MM-DD`. */
  due_date?: string;
  /** Section 4.5: carried on every call. The API has no wire field for it yet; see OPEN_QUESTIONS. */
  actor: Actor;
}

export type RailOutcome =
  | {
      /**
       * The rail took the attempt and the outcome comes later: a receivable
       * was issued and its payer has not acted yet. The execution stays
       * `executing`; `lookup()` or a `commerce.charge.*` event closes it.
       */
      status: "accepted";
      transaction_id: string;
      instrument: ChargeInstrument;
      sandbox: boolean;
      raw: unknown;
    }
  | {
      status: "settled";
      transaction_id: string;
      receipt_id: string | null;
      money_moved: boolean;
      sandbox: boolean;
      raw: unknown;
    }
  | {
      /** The rail answered and refused. Nothing moved. */
      status: "failed";
      code: string;
      message: string;
      raw?: unknown;
    }
  | {
      /** The outcome is unknown (timeout, 5xx, `psp_dispatch_uncertain`). Never retried blind: reconciled. */
      status: "uncertain";
      code: string;
      message: string;
      raw?: unknown;
    };

export interface RailReceipt {
  receipt_id: string;
  /** `payment` (the API's sealed receipt) or `charge` (the paid receivable as the API reports it; no seal exists for it today). */
  kind?: "payment" | "charge";
  state: string;
  mandate: { id: string };
  payment: { amount_minor: number; payee: string | null; attempt_id: string; money_moved: boolean; sandbox: boolean; at: string };
  /** Null when the API seals nothing for this kind of record. */
  chain: string | null;
  receipt_sig: string | null;
  /** Section 4.5: the kit stamps the actor onto the local copy of every receipt. */
  actor: Actor;
  raw: unknown;
}

/** What a reconcile learns: a recorded outcome, "still running", or nothing. Never a new payment. */
export type RailLookup = RailOutcome | { status: "in_flight" } | undefined;

export interface PaymentRail {
  readonly name: "stub" | "codespar" | "stub-charge" | "codespar-charge";
  pay(payment: RailPayment): Promise<RailOutcome>;
  /** Answers the outcome of an attempt already presented, `in_flight` while the rail is still on it, or `undefined` when the rail never saw it. */
  lookup(attemptId: string, payment: RailPayment): Promise<RailLookup>;
  receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined>;
}
