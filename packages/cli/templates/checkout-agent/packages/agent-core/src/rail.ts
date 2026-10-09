/**
 * The payment rail the core dispatches to once an execution is `executing`.
 * Two implementations: the CodeSpar sandbox through the API (needs a
 * `csk_test_` key) and a local stub persisted in state.db for CI and
 * scenarios. Idempotence is OPT-IN on the API and the core always opts in:
 * every payment carries an explicit `attempt_id`, and presenting the same
 * attempt again answers from the rail's record of it instead of paying twice
 * (ent#1671): the original outcome when it settled, "still running" while it
 * is in flight, "unknown, reconcile" while it is pinned, and a refusal when
 * the same id arrives with a different payment. A payment sent WITHOUT an id
 * is a new payment every time; nothing here sends one.
 */
import type { ApiOperation, ApiRequestBody } from "@codespar/sdk";
import type { SpendQuote } from "./quote.js";
import type { Actor, ApprovalArtifact, ChargeInstrument } from "./types.js";

/**
 * The `approval` a spend presents (`SpendApproval` in the API's document,
 * typed since @codespar/sdk 0.16.10): `sha256:<64 lowercase hex>`, as
 * `itemsHash` and `batchHash` write it. Taken from the SDK so a change on
 * the API's side fails `tsc` here.
 */
export type SpendApproval = NonNullable<ApiRequestBody<ApiOperation<"/v1/consumer-payments/execute", "post">>["approval"]>;

/** What a receipt says it SEALED as the approval link: `batch_hash` is null when the spend sent none. */
export interface SealedSpendApproval {
  items_hash: string;
  batch_hash: string | null;
}

/** The hashes of what was approved, for a spend of any line of this artifact: the ones the artifact's own HMAC covers. */
export function spendApprovalOf(artifact: Pick<ApprovalArtifact, "items_hash" | "batch">): SpendApproval {
  return { items_hash: artifact.items_hash, ...(artifact.batch ? { batch_hash: artifact.batch.batch_hash } : {}) };
}

const APPROVAL_HASH = /^(sha256:)?[0-9a-f]{64}$/;

/**
 * The approval a spend presents, or why it may not go out: none, or a hash
 * the API would refuse (`invalid_approval_hash`: lowercase hex SHA-256, the
 * `sha256:` prefix optional). The shape and never the content, like the API:
 * WHICH list is the artifact's business, checked before `executing`.
 */
export function checkSpendApproval(payment: { approval?: SpendApproval | undefined }): { ok: true; approval: SpendApproval } | { ok: false; code: "approval_missing" | "approval_malformed"; detail: string } {
  const { approval } = payment;
  if (!approval) return { ok: false, code: "approval_missing", detail: "a spend carries the hashes of the approval artifact, or it does not go out" };
  if (!APPROVAL_HASH.test(approval.items_hash)) return { ok: false, code: "approval_malformed", detail: "the approval's items_hash is not a lowercase hex SHA-256" };
  if (approval.batch_hash !== undefined && !APPROVAL_HASH.test(approval.batch_hash)) return { ok: false, code: "approval_malformed", detail: "the approval's batch_hash is not a lowercase hex SHA-256" };
  return { ok: true, approval };
}

export interface RailPayment {
  attempt_id: string;
  mandate_id: string;
  amount_minor: number;
  currency: string;
  payee: string;
  purpose: string;
  agent_id: string;
  /** The principal the agent acts for (the mandate's `consumer_id`). A receivable settles into THIS identity's account; `POST /v1/charges` needs it on the wire. */
  consumer_id?: string;
  description?: string;
  /** Display name of the counterparty (a receivable's debtor). The rail that issues a charge needs it; a payout rail ignores it. */
  beneficiary?: string;
  /** Due date of a receivable, `YYYY-MM-DD`. */
  due_date?: string;
  /** What was approved for this line, presented with a spend so the sealed receipt names the payee. A charge rail ignores it. */
  quote?: SpendQuote;
  /**
   * The approval artifact's hashes, exactly as the artifact carries them: its
   * `items_hash`, and for a batch line its `batch.batch_hash`. The API seals
   * them into the receipt's chain as a link of their own (chain v4,
   * ent#1670), so whoever holds the receipt read can show THIS payment was
   * sealed against THAT list. It is the caller's claim, sealed: the API checks
   * its shape and never its content. A charge rail ignores it.
   */
  approval?: SpendApproval;
  /** Section 4.5: carried on every call, on the wire as `PaymentActor` (`wireActorOf`) since @codespar/sdk 0.16.10; see OPEN_QUESTIONS §2. */
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
      /**
       * The rail answered from its record of an attempt that had ALREADY
       * settled (`idempotent_replay`, ent#1671): every other field is the
       * original answer, and nothing moved, was held or was sealed by this
       * call. Absent on the call that settled it.
       */
      replayed?: true;
      raw: unknown;
    }
  | {
      /** The rail answered and refused. Nothing moved. */
      status: "failed";
      code: string;
      message: string;
      /**
       * The rail holds this `attempt_id` as an attempt that failed and moved
       * no money, and will refuse it for good (`psp_attempt_conflict`). Set
       * only on that answer: the id is spent, and a batch line pays under the
       * next generation of its id (`batchAttemptId`).
       */
      spent?: true;
      /**
       * The rail holds this `attempt_id` for something else: a DIFFERENT
       * payment (`attempt_id_conflict`, checked before whatever became of it)
       * or another project of the organization (`attempt_id_unavailable`).
       * Nothing was held or sent. Never `spent`: the id is not free and not
       * burned, it is someone else's, and presenting it again answers the same.
       */
      held?: "conflict" | "unavailable";
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
  /** `sig_sha256` is SHA-256 of the mandate's own signature, which a v4 chain seals in place of it; never the signature itself, which is a bearer proof. */
  mandate: { id: string; sig_sha256?: string };
  /**
   * The chain format the receipt was sealed under (4 once it carries the
   * approval link), and the approval it sealed, as the API read them back:
   * `null` when it sealed none. Absent when the rail cannot say — a charge,
   * which seals nothing.
   */
  chain_version?: number;
  approval?: SealedSpendApproval | null;
  /** `payee` is the one the receipt SEALED — the quote's, on a payment — and null when it sealed none. Never copied from the execution. */
  payment: { amount_minor: number; payee: string | null; attempt_id: string; money_moved: boolean; sandbox: boolean; at: string };
  /** Null when the API seals nothing for this kind of record. */
  chain: string | null;
  receipt_sig: string | null;
  /** The Ed25519 signature CodeSpar seals alongside the HMAC (base64url) and
   *  the published key that made it. Null on a receipt sealed before the API
   *  had the capability, on a record the API seals nothing for (a paid
   *  charge), and on the stub rail, which is not CodeSpar and must not look
   *  like it. Carried onto the bundle's copy so THAT copy is what a third
   *  party checks: `npm run verify runs/<run-id>/receipts/<id>.json`. */
  receipt_sig_ed25519: string | null;
  receipt_sig_kid: string | null;
  /** Section 4.5: the kit stamps the actor onto the local copy of every receipt. */
  actor: Actor;
  /**
   * The actor the API RECORDED for the spend and read back (`PaymentActor`,
   * @codespar/sdk 0.16.10): `null` when it recorded none — an API that did not
   * take the field, or a spend that sent none. Absent when the rail cannot
   * say: a charge, which records no actor.
   */
  sealed_actor?: WireActor | null;
  raw: unknown;
}

/**
 * Who triggered a spend, in the API's own shape (`PaymentActor`,
 * @codespar/sdk 0.16.10): the agent by its identifier and the consumer it acts
 * for, or the person by id and the channel they acted from. The kit's `Actor`
 * names the agent under `agent`; the wire names it under `id`, and that is the
 * only difference.
 */
export type WireActor = { type: "agent"; id: string; on_behalf_of: string } | { type: "human"; id: string; channel?: string };

export function wireActorOf(actor: Actor): WireActor {
  return actor.type === "agent" ? { type: "agent", id: actor.agent, on_behalf_of: actor.on_behalf_of } : { type: "human", id: actor.id, channel: actor.channel };
}

/** The same actor, field for field. A human's channel counts: the same person on WhatsApp and on a dashboard are two events. */
export function sameWireActor(a: WireActor | null, b: WireActor | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type === "agent" && b.type === "agent") return a.id === b.id && a.on_behalf_of === b.on_behalf_of;
  if (a.type === "human" && b.type === "human") return a.id === b.id && (a.channel ?? null) === (b.channel ?? null);
  return false;
}

/** What a reconcile learns: a recorded outcome, "still running", or nothing. Never a new payment. */
export type RailLookup = RailOutcome | { status: "in_flight" } | undefined;

export interface PaymentRail {
  readonly name: "stub" | "codespar" | "stub-charge" | "codespar-charge";
  pay(payment: RailPayment): Promise<RailOutcome>;
  /**
   * Answers the outcome of an attempt already presented, `in_flight` while the rail is still on it, or `undefined` when the rail
   * never saw it. `transactionId` is the rail's own id for the attempt when the core recorded one (an accepted receivable): a rail
   * whose read is keyed on its id and not on the caller's key looks it up by that.
   */
  lookup(attemptId: string, payment: RailPayment, transactionId?: string): Promise<RailLookup>;
  receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined>;
}
