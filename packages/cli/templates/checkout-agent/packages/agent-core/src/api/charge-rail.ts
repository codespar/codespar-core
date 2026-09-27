/**
 * The CodeSpar receivable rail: the merchant COLLECTS. `pay()` issues a
 * cobranca com vencimento through `POST /v1/charges` (the REST form of the
 * `codespar_charge` meta-tool, action=create): `method: "boleto"` plus a
 * `due_date` is what makes it ONE receivable the payer settles either by
 * boleto or by Pix; `idempotency_key` is REQUIRED on that create and is our
 * attempt id, so a retry returns the same charge instead of a second
 * receivable the same debtor could pay twice. An immediate Pix
 * (`method: "pix"`) is deliberately not used: the API does not replay its
 * create on a key and does not read it back, so it cannot close a loop.
 *
 * `lookup()` is `GET /v1/charges/{id}`, which accepts our idempotency key as
 * the id; the kit polls it to close the cycle when no webhook can reach a
 * terminal. Branching is on `local_status` and the normalized `status`, never
 * on prose. Amounts cross the wire in MAJOR units (`amount: 1080.5`), which
 * is what `coerceMetaChargeArgs` reads; the answer's `amount_minor` is
 * compared with what was asked and a mismatch is a failure, not a charge.
 *
 * There is no receipt object for a receivable; the paid charge as the API
 * reports it is what the bundle keeps, marked `kind: "charge"` and unsealed.
 */
import type { ApiClient, ApiOperation, ApiSuccess } from "@codespar/sdk";
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { Actor, ChargeInstrument } from "../types.js";
import { describeApiError, isUncertain, type ApiErrorCode } from "./client.js";

/** The `/v1/charges/{chargeId}` answer, as the SDK's generated OpenAPI types it. The create answers the same shape, and the compiler holds them together. */
export type ChargeView = ApiSuccess<ApiOperation<"/v1/charges/{chargeId}", "get">>;

/**
 * Documented as the read's 409. The create does not document it, and the
 * create's error path below still treats it as uncertain, which is the safe
 * reading of a code the route is not known to send (OPEN_QUESTIONS §8).
 */
const ISSUANCE_UNCONFIRMED: ApiErrorCode<ApiOperation<"/v1/charges/{chargeId}", "get">> = "issuance_unconfirmed";

/** The read's other 409: the reference matched more than one charge. Terminal for that reference; the API answers by the charge id. */
const REFERENCE_AMBIGUOUS: ApiErrorCode<ApiOperation<"/v1/charges/{chargeId}", "get">> = "charge_reference_ambiguous";

type ChargeRead =
  | { kind: "view"; view: ChargeView }
  | { kind: "missing" }
  | { kind: "in_flight" }
  | { kind: "failed"; outcome: Extract<RailOutcome, { status: "failed" }> }
  | { kind: "uncertain"; outcome: Extract<RailOutcome, { status: "uncertain" }> };

/**
 * When the charge settled, if the answer says so. `settled_at` is a column of
 * the charge row, but the SDK's type for the read does not carry it, so this
 * is the one field here read outside the type (OPEN_QUESTIONS §8).
 */
function settledAt(view: ChargeView): string | undefined {
  const value: unknown = (view as Record<string, unknown>)["settled_at"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function instrumentOf(view: ChargeView): ChargeInstrument {
  return {
    payable: view.payable,
    status: view.status,
    pix_copy_paste: view.pix_copy_paste,
    boleto_bank_line: view.boleto_bank_line,
    boleto_bar_code: view.boleto_bar_code,
    due_date: view.due_date,
  };
}

/** What a charge view means for the attempt. The row's own status wins over the issuer's normalized one where they name a terminal state. */
export function outcomeOf(view: ChargeView): RailOutcome | { status: "in_flight" } {
  if (view.issuance_unconfirmed || !view.id) return { status: "in_flight" };
  const id = view.id;
  if (view.local_status === "settled" || view.status === "CONFIRMED" || view.settlement === "confirmed") {
    return { status: "settled", transaction_id: id, receipt_id: id, money_moved: false, sandbox: true, raw: view };
  }
  if (view.local_status === "expired" || view.status === "EXPIRED") {
    return { status: "failed", code: "charge_expired", message: `charge ${id} reached its due date unpaid`, raw: view };
  }
  if (view.status === "CANCELLED" || view.local_status === "cancelled") {
    return { status: "failed", code: "charge_cancelled", message: `charge ${id} was withdrawn`, raw: view };
  }
  return { status: "accepted", transaction_id: id, instrument: instrumentOf(view), sandbox: true, raw: view };
}

export class CodeSparChargeRail implements PaymentRail {
  readonly name = "codespar-charge" as const;

  constructor(private readonly api: ApiClient) {}

  async pay(payment: RailPayment): Promise<RailOutcome> {
    if (!payment.due_date) return { status: "failed", code: "due_date_required", message: "a receivable needs a due_date; the immediate Pix charge cannot be read back or replayed" };
    if (!payment.consumer_id) return { status: "failed", code: "consumer_id_required", message: "a receivable settles into the principal's account; the policy names no consumer_id" };
    let view: ChargeView;
    try {
      view = await this.api.post("/v1/charges", {
        body: {
          consumer_id: payment.consumer_id,
          amount: payment.amount_minor / 100,
          currency: payment.currency,
          method: "boleto",
          description: payment.description ?? payment.purpose,
          buyer: { name: payment.beneficiary ?? payment.payee, document: payment.payee },
          due_date: payment.due_date,
          idempotency_key: payment.attempt_id,
        },
      });
    } catch (err) {
      const failure = describeApiError(err);
      if (isUncertain(failure) || failure.code === ISSUANCE_UNCONFIRMED) return { status: "uncertain", code: failure.code, message: failure.message };
      return { status: "failed", code: failure.code, message: failure.message };
    }
    if (view.issuance_unconfirmed || !view.id) return { status: "uncertain", code: ISSUANCE_UNCONFIRMED, message: "the issuer's answer to the create was lost; the key is reserved and a later read resolves it" };
    if (view.amount_minor !== payment.amount_minor) {
      // The API understood another amount than the one approved. The receivable exists; withdraw it rather than leave a debt nobody approved.
      const withdrawn = await this.withdraw(view.id);
      return { status: "failed", code: "amount_mismatch", message: `the API issued ${view.amount_minor} for a request of ${payment.amount_minor} (charge ${view.id}); ${withdrawn ? "withdrawn" : "withdrawal refused, an operator must cancel it"}` };
    }
    const outcome = outcomeOf(view);
    // `in_flight` is excluded above (`issuance_unconfirmed` / no id); the create answers a state, never "still running".
    return outcome.status === "in_flight" ? { status: "uncertain", code: ISSUANCE_UNCONFIRMED, message: "the create answered no readable state" } : outcome;
  }

  /**
   * By the charge id when the create handed one back; by our idempotency key only when it did not (the create's answer was lost).
   * The route's doc says the read accepts the caller's key as the id; on staging (2026-09-23) it answered `charge_not_found` for
   * the key and the charge for the id, so the id comes first and the key is the fallback, not the other way round.
   */
  async lookup(attemptId: string, _payment: RailPayment, transactionId?: string): Promise<RailLookup> {
    const byId = transactionId ? await this.read(transactionId) : { kind: "missing" as const };
    if (byId.kind === "view") return outcomeOf(byId.view);
    if (byId.kind === "in_flight") return { status: "in_flight" };
    if (byId.kind === "failed" || byId.kind === "uncertain") return byId.outcome;
    const byKey = await this.read(attemptId);
    if (byKey.kind === "view") return outcomeOf(byKey.view);
    if (byKey.kind === "in_flight") return { status: "in_flight" };
    if (byKey.kind === "failed" || byKey.kind === "uncertain") return byKey.outcome;
    return undefined;
  }

  /**
   * A 409 is branched on its code, never on the status alone: only `issuance_unconfirmed` means "still issuing".
   * `charge_reference_ambiguous` is terminal for the reference and fails explicitly instead of being polled forever,
   * and a 409 whose code this kit does not read is a failure too.
   */
  private async read(chargeRef: string): Promise<ChargeRead> {
    try {
      const view = await this.api.get("/v1/charges/{chargeId}", { path: { chargeId: chargeRef } });
      return { kind: "view", view };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return { kind: "missing" };
      if (failure.status === 409) {
        if (failure.code === ISSUANCE_UNCONFIRMED) return { kind: "in_flight" };
        const message =
          failure.code === REFERENCE_AMBIGUOUS
            ? `the reference ${chargeRef} matches more than one charge, and the API answers for the charge id only; which one is this attempt's is not assumed, so reconcile it by the charge id`
            : `GET /v1/charges/${chargeRef} answered 409 with a code this kit does not read (${failure.code}); it is not read as a charge still issuing`;
        return { kind: "failed", outcome: { status: "failed", code: failure.code, message } };
      }
      return { kind: "uncertain", outcome: { status: "uncertain", code: failure.code, message: failure.message } };
    }
  }

  async receipt(chargeId: string, actor: Actor): Promise<RailReceipt | undefined> {
    try {
      const view = await this.api.get("/v1/charges/{chargeId}", { path: { chargeId } });
      return {
        receipt_id: chargeId,
        kind: "charge",
        state: view.local_status === "settled" ? "paid" : view.local_status,
        mandate: { id: "n/a" },
        // The read names no buyer, so the payee is not on this record; the execution's item names the debtor.
        payment: { amount_minor: view.amount_minor, payee: null, attempt_id: chargeId, money_moved: false, sandbox: true, at: settledAt(view) ?? new Date().toISOString() },
        chain: null,
        receipt_sig: null,
        receipt_sig_ed25519: null,
        receipt_sig_kid: null,
        actor,
        raw: view,
      };
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return undefined;
      throw err;
    }
  }

  private async withdraw(chargeId: string): Promise<boolean> {
    try {
      await this.api.post("/v1/charges/{chargeId}/cancel", { path: { chargeId } });
      return true;
    } catch {
      return false;
    }
  }
}
