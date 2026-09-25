/**
 * The CodeSpar sandbox rail. With the signed envelope the consent returned
 * (`mandate.canonical` + `mandate.signature`) it spends through
 * `POST /v1/consumer-payments/execute`; without it, by mandate id through
 * `POST /v1/consumers/mandates/{id}/spend`. Both are idempotent on
 * `attempt_id`. The by-id route answered `bad_signature` on staging for a
 * mandate carrying `periodic_cap` (OPEN_QUESTIONS §14), which is why the
 * envelope is preferred when it exists. Receipts come back from
 * `GET /v1/consumers/receipts/{id}`.
 *
 * The API has no `actor` field on the wire today (OPEN_QUESTIONS §2). The
 * spend carries `agent_id`, which the mandate binds; the full actor is
 * stamped on the local receipt copy and on every event of the bundle.
 */
import type { ApiClient } from "@codespar/sdk";
import type { Mandate } from "../mandate.js";
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { Actor } from "../types.js";
import { describeApiError, isUncertain } from "./client.js";

/** The asymmetric seal as the API serves it, or nulls when this deployment
 *  does not serve one. Never throws on a shape it does not recognise: a
 *  receipt is evidence of a payment that already happened, and refusing to
 *  record it over an unexpected field would trade the record for the proof. */
function readEd25519Seal(body: unknown): { receipt_sig_ed25519: string | null; receipt_sig_kid: string | null } {
  const r = body as { receipt_sig_ed25519?: unknown; receipt_sig_kid?: unknown };
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return { receipt_sig_ed25519: str(r.receipt_sig_ed25519), receipt_sig_kid: str(r.receipt_sig_kid) };
}

export class CodeSparRail implements PaymentRail {
  readonly name = "codespar" as const;

  constructor(
    private readonly api: ApiClient,
    private readonly envelope?: Pick<Mandate, "canonical" | "signature"> | undefined,
  ) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
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
              },
            })
          : await this.api.post("/v1/consumers/mandates/{id}/spend", {
              path: { id: payment.mandate_id },
              body: { amount_minor: payment.amount_minor, payee: payment.payee, agent_id: payment.agent_id, attempt_id: payment.attempt_id },
            });
      return {
        status: "settled",
        transaction_id: outcome.payment.transactionId,
        receipt_id: outcome.receipt?.id ?? null,
        money_moved: outcome.payment.moneyMoved,
        sandbox: !outcome.payment.moneyMoved,
        raw: outcome,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (isUncertain(failure)) return { status: "uncertain", code: failure.code, message: failure.message };
      return { status: "failed", code: failure.code, message: failure.message };
    }
  }

  /**
   * There is no read route for an attempt. The documented way is to present
   * the same `attempt_id` again: the lifecycle is idempotent on it and
   * answers the state it reached. `psp_attempt_in_flight` means the first
   * presentation is still running.
   */
  async lookup(_attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const outcome = await this.pay(payment);
    if (outcome.status === "failed" && outcome.code === "psp_attempt_in_flight") return { status: "in_flight" };
    return outcome;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    try {
      const r = await this.api.get("/v1/consumers/receipts/{id}", { path: { id: receiptId } });
      return {
        receipt_id: r.receipt_id,
        state: r.state,
        mandate: { id: r.mandate.id },
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
        // ent#1633 landed after `@codespar/sdk@0.16.6` was generated, so the
        // typed response does not carry these two yet. Read off the body
        // defensively rather than pinning a new SDK for two nullable strings:
        // a deployment that predates the change answers null, which is the
        // same answer the columns hold and reads as `unsigned`.
        ...readEd25519Seal(r),
        actor,
        raw: r,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return undefined;
      throw err;
    }
  }
}
