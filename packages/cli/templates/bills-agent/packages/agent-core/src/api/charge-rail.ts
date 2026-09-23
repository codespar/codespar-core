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
import type { ApiClient } from "@codespar/sdk";
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { Actor, ChargeInstrument } from "../types.js";
import { describeApiError, isUncertain } from "./client.js";

/** The `/v1/charges` answer, as the SDK types it. */
export interface ChargeView {
  id: string | null;
  status: string;
  local_status: string;
  status_conflict: boolean;
  method: string;
  currency: string;
  amount: number;
  amount_minor: number;
  due_date: string | null;
  payable: boolean;
  boleto_bar_code: string | null;
  boleto_bank_line: string | null;
  pix_copy_paste: string | null;
  credit_correlation_armed: boolean;
  payment_in_flight: boolean;
  settlement: "confirmed" | "pending" | "unconfirmable" | null;
  issuance_unconfirmed: boolean;
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
    let view: ChargeView;
    try {
      view = (await this.api.post("/v1/charges", {
        body: {
          amount: payment.amount_minor / 100,
          currency: payment.currency,
          method: "boleto",
          description: payment.description ?? payment.purpose,
          buyer: { name: payment.beneficiary ?? payment.payee, document: payment.payee },
          due_date: payment.due_date,
          idempotency_key: payment.attempt_id,
        },
      })) as ChargeView;
    } catch (err) {
      const failure = describeApiError(err);
      if (isUncertain(failure) || failure.code === "issuance_unconfirmed") return { status: "uncertain", code: failure.code, message: failure.message };
      return { status: "failed", code: failure.code, message: failure.message };
    }
    if (view.issuance_unconfirmed || !view.id) return { status: "uncertain", code: "issuance_unconfirmed", message: "the issuer's answer to the create was lost; the key is reserved and a later read resolves it" };
    if (view.amount_minor !== payment.amount_minor) {
      // The API understood another amount than the one approved. The receivable exists; withdraw it rather than leave a debt nobody approved.
      const withdrawn = await this.withdraw(view.id);
      return { status: "failed", code: "amount_mismatch", message: `the API issued ${view.amount_minor} for a request of ${payment.amount_minor} (charge ${view.id}); ${withdrawn ? "withdrawn" : "withdrawal refused, an operator must cancel it"}` };
    }
    const outcome = outcomeOf(view);
    // `in_flight` is excluded above (`issuance_unconfirmed` / no id); the create answers a state, never "still running".
    return outcome.status === "in_flight" ? { status: "uncertain", code: "issuance_unconfirmed", message: "the create answered no readable state" } : outcome;
  }

  async lookup(attemptId: string, _payment: RailPayment): Promise<RailLookup> {
    try {
      const view = (await this.api.get("/v1/charges/{chargeId}", { path: { chargeId: attemptId } })) as ChargeView;
      return outcomeOf(view);
    } catch (err) {
      const failure = describeApiError(err);
      if (failure.status === 404) return undefined;
      if (failure.status === 409) return { status: "in_flight" };
      return { status: "uncertain", code: failure.code, message: failure.message };
    }
  }

  async receipt(chargeId: string, actor: Actor): Promise<RailReceipt | undefined> {
    try {
      const view = (await this.api.get("/v1/charges/{chargeId}", { path: { chargeId } })) as ChargeView;
      const raw = view as ChargeView & { settled_at?: string };
      return {
        receipt_id: chargeId,
        kind: "charge",
        state: view.local_status === "settled" ? "paid" : view.local_status,
        mandate: { id: "n/a" },
        // The read names no buyer, so the payee is not on this record; the execution's item names the debtor.
        payment: { amount_minor: view.amount_minor, payee: null, attempt_id: chargeId, money_moved: false, sandbox: true, at: raw.settled_at ?? new Date().toISOString() },
        chain: null,
        receipt_sig: null,
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
