/**
 * The CodeSpar sandbox rail. With the signed envelope the consent returned
 * (`mandate.canonical` + `mandate.signature`) it spends through
 * `POST /v1/consumer-payments/execute`; without it, by mandate id through
 * `POST /v1/consumers/mandates/{id}/spend`. Idempotence on both is OPT-IN
 * and keyed on an explicit `attempt_id`, which every payment here carries: a
 * spend without one is a fresh payment on every request (ent#1671, #1683).
 * What a repeat of an attempt answers is in `lookup` below. The by-id route answered `bad_signature` on staging for a
 * mandate carrying `periodic_cap` (OPEN_QUESTIONS §14), which is why the
 * envelope is preferred when it exists. Receipts come back from
 * `GET /v1/consumers/receipts/{id}`.
 *
 * Every spend carries the kit's `actor` on the wire (`PaymentActor`,
 * @codespar/sdk 0.16.10): the agent and the consumer it acts for, or the
 * person and their channel. The API records it on the receipt and reads it
 * back, and the engine compares what came back with what was sent
 * (OPEN_QUESTIONS §2). `agent_id` still goes too: it names the agent the
 * mandate was SIGNED for, which is an authority, not the event.
 */
import type { ApiClient } from "@codespar/sdk";
import type { Mandate } from "../mandate.js";
import { checkQuote } from "../quote.js";
import { checkSpendApproval, wireActorOf, type PaymentRail, type RailLookup, type RailOutcome, type RailPayment, type RailReceipt } from "../rail.js";
import type { Actor } from "../types.js";
import { describeApiError, isUncertain, type SpendErrorCode } from "./client.js";

/** Another presentation of this attempt is claimed and has no recorded outcome yet: it may be moving money right now. */
const ATTEMPT_IN_FLIGHT: SpendErrorCode = "psp_attempt_in_flight";
/** This attempt failed, moved no money and was compensated; the API will never run this id again. */
const ATTEMPT_SPENT: SpendErrorCode = "psp_attempt_conflict";
/** This attempt id was already used for a DIFFERENT payment (checked before its state); nothing was held or sent. */
const ATTEMPT_ID_CONFLICT: SpendErrorCode = "attempt_id_conflict";
/** Another project of this organization holds this attempt id; opaque by design, nothing was held or sent. */
const ATTEMPT_ID_UNAVAILABLE: SpendErrorCode = "attempt_id_unavailable";

export class CodeSparRail implements PaymentRail {
  readonly name = "codespar" as const;

  constructor(
    private readonly api: ApiClient,
    private readonly envelope?: Pick<Mandate, "canonical" | "signature"> | undefined,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    // Without the quote the sealed receipt names no payee (OPEN_QUESTIONS §18), and the API pays a quote that disagrees. Neither goes out.
    const quoted = checkQuote(payment);
    if (!quoted.ok) return { status: "failed", code: quoted.code, message: `${quoted.detail}; nothing was sent` };
    // Without it the receipt seals no link to what was approved (OPEN_QUESTIONS §3), and the API refuses a malformed one with 400 anyway.
    const approval = checkSpendApproval(payment);
    if (!approval.ok) return { status: "failed", code: approval.code, message: `${approval.detail}; nothing was sent` };
    try {
      const outcome =
        this.envelope?.canonical && this.envelope.signature
          ? await this.api.post("/v1/consumer-payments/execute", {
              body: {
                mandate: this.envelope.canonical,
                signature: this.envelope.signature,
                amount_minor: payment.amount_minor,
                purpose: payment.purpose,
                agent_id: payment.agent_id,
                payee: payment.payee,
                attempt_id: payment.attempt_id,
                quote: quoted.quote,
                approval: approval.approval,
                actor: wireActorOf(payment.actor),
              },
            })
          : await this.api.post("/v1/consumers/mandates/{id}/spend", {
              path: { id: payment.mandate_id },
              body: { amount_minor: payment.amount_minor, payee: payment.payee, agent_id: payment.agent_id, attempt_id: payment.attempt_id, quote: quoted.quote, approval: approval.approval, actor: wireActorOf(payment.actor) },
            });
      return {
        status: "settled",
        transaction_id: outcome.payment.transactionId,
        receipt_id: outcome.receipt?.id ?? null,
        money_moved: outcome.payment.moneyMoved,
        sandbox: !outcome.payment.moneyMoved,
        ...(outcome.idempotent_replay ? { replayed: true as const } : {}),
        raw: outcome,
      };
    } catch (err) {
      const failure = describeApiError(err);
      // Not a refusal: the other presentation may already have reached the provider, so "nothing moved" would be a claim nobody can make.
      if (failure.code === ATTEMPT_IN_FLIGHT) return { status: "uncertain", code: failure.code, message: failure.message };
      if (isUncertain(failure)) return { status: "uncertain", code: failure.code, message: failure.message };
      if (failure.code === ATTEMPT_SPENT) return { status: "failed", code: failure.code, message: failure.message, spent: true };
      // Held, never spent: the id belongs to another payment or another project, so no generation may be derived past it.
      if (failure.code === ATTEMPT_ID_CONFLICT) return { status: "failed", code: failure.code, message: failure.message, held: "conflict" };
      if (failure.code === ATTEMPT_ID_UNAVAILABLE) return { status: "failed", code: failure.code, message: failure.message, held: "unavailable" };
      return { status: "failed", code: failure.code, message: failure.message };
    }
  }

  /**
   * There is no read route for an attempt: the way to learn what became of
   * one is to present the same `attempt_id`, with the same payment, again.
   * Against the deployed API (ent#1671, #1683) that call never moves money
   * for an attempt it already holds, and each answer maps to one reading:
   *
   * - settled: `200` with the ORIGINAL body verbatim (same `transactionId`,
   *   same stored `receipt.id`, which the receipt route resolves) plus
   *   `idempotent_replay: true`. Read as `settled`, exactly as the first
   *   answer, and marked `replayed`.
   * - `psp_attempt_in_flight` (409): claimed, no outcome yet, on every rail.
   *   Read as `in_flight`; the next reconcile asks again with the SAME id.
   * - `psp_attempt_uncertain` (409): pinned, dispatch outcome unknown. Read as
   *   `uncertain`, which leaves the execution open for a person.
   * - `psp_attempt_conflict` (409): failed, compensated, no money. Read as
   *   `failed` and `spent`.
   * - `attempt_id_conflict` / `attempt_id_unavailable` (409): the id is held for
   *   a different payment, or by another project. Read as `failed` and `held`,
   *   never `spent`: nothing was held or sent by this call. Neither can come from re-presenting the
   *   payment this execution sent, whose tuple is the one the id was claimed
   *   with, so seeing one here is a defect worth its readable failure.
   * - an attempt the API never took: there is no record to answer from, so
   *   this call IS the payment. Reconcile runs only after the outbox row
   *   flipped to `sent`, so an attempt it looks up was presented once already.
   */
  async lookup(_attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const outcome = await this.pay(payment);
    if (outcome.status === "uncertain" && outcome.code === ATTEMPT_IN_FLIGHT) return { status: "in_flight" };
    return outcome;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    try {
      const r = await this.api.get("/v1/consumers/receipts/{id}", { path: { id: receiptId } });
      return {
        receipt_id: r.receipt_id,
        state: r.state,
        mandate: { id: r.mandate.id, sig_sha256: r.mandate.sig_sha256 },
        chain_version: r.chain_version,
        approval: r.approval ?? null,
        payment: {
          amount_minor: r.payment.amount_minor,
          payee: r.quote?.payee ?? null,
          attempt_id: r.payment.attempt_id,
          money_moved: r.payment.money_moved,
          sandbox: r.payment.sandbox === true,
          at: r.payment.at,
        },
        chain: r.chain,
        receipt_sig: r.receipt_sig,
        // `||`, not `??`: a deployment older than ent#1633 omits both fields,
        // and an empty string is no signature either. Both read as `unsigned`.
        receipt_sig_ed25519: r.receipt_sig_ed25519 || null,
        receipt_sig_kid: r.receipt_sig_kid || null,
        actor,
        // What the API recorded, as it read it back; the engine compares it with what the spend sent.
        sealed_actor: r.actor,
        raw: r,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return undefined;
      throw err;
    }
  }
}
