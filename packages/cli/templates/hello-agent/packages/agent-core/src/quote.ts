/**
 * The offer a spend presents to the API (`SpendQuote`): seller, resource,
 * price and payee. When a spend carries one, the API binds it into the
 * receipt's chain between the mandate and the payment, so the sealed receipt
 * names the payee; without one the chain carries no payee at all, and
 * `GET /v1/consumers/receipts/{id}` answers `quote: null` (OPEN_QUESTIONS §18).
 *
 * The quote is built from the approval artifact's items, the list its
 * `items_hash` covers, and from nothing the model says after approval. The
 * API compares the quote to what settled in OBSERVE mode only: a divergence is
 * recorded on the receipt and the money still moves. So the kit refuses a
 * divergence itself, before the call.
 */
import type { ApprovalArtifact } from "./types.js";

export interface SpendQuote {
  seller: string;
  resource: string;
  price_minor: number;
  payee: string;
  /**
   * When the offer was approved: the artifact's `approved_at`. Absent on a
   * batch line, whose quote must be the same on every run of the list: the
   * API compares the quote's digest on a repeat of an `attempt_id`, so an
   * approval time in it would make the same line a different payment on
   * every machine (OPEN_QUESTIONS §39c). The time is still in the artifact.
   */
  at?: string;
}

/**
 * The quote for line `index` of what was approved, or undefined when the
 * artifact has no such line. `stable` leaves the approval time out, for a
 * batch line (see `SpendQuote.at`).
 */
export function quoteFromApproval(artifact: ApprovalArtifact, index: number, purpose: string, options: { stable?: boolean } = {}): SpendQuote | undefined {
  const item = artifact.items[index];
  if (!item) return undefined;
  const quote = { seller: item.beneficiary, resource: item.description ?? purpose, price_minor: item.amount, payee: item.payee };
  return options.stable ? quote : { ...quote, at: artifact.approved_at };
}

/** The quote a spend presents, or why it may not go out: none, or one that does not name exactly the amount and the payee it pays. */
export function checkQuote(payment: { amount_minor: number; payee: string; quote?: SpendQuote | undefined }): { ok: true; quote: SpendQuote } | { ok: false; code: "quote_missing" | "quote_mismatch"; detail: string } {
  const { quote } = payment;
  if (!quote) return { ok: false, code: "quote_missing", detail: "a spend carries the quote of what was approved, or it does not go out" };
  if (quote.price_minor !== payment.amount_minor) return { ok: false, code: "quote_mismatch", detail: `the approved price ${quote.price_minor} is not the amount ${payment.amount_minor} about to be spent` };
  if (quote.payee !== payment.payee) return { ok: false, code: "quote_mismatch", detail: "the approved payee is not the payee about to be paid" };
  return { ok: true, quote };
}
