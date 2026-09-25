/**
 * The events the CodeSpar API publishes, as an agent may declare them under
 * `events:` in `agent.yaml`. The list is the one place the kits keep it;
 * `npm run check` refuses a manifest entry outside it.
 *
 * Source: codespar-enterprise `packages/api/src` (the publishers behind
 * `/v1/triggers`), measured 2026-09-23. Update it against that tree, never
 * from memory.
 */
export const PUBLISHED_EVENTS = [
  "commerce.payment.succeeded",
  "commerce.payment.failed",
  "commerce.payment.pending",
  "commerce.payment.refunded",
  "commerce.payment.updated",
  "commerce.pix_out.succeeded",
  "commerce.pix_out.failed",
  "commerce.charge.created",
  "commerce.charge.paid",
  "commerce.charge.expired",
  "commerce.charge.cancelled",
  "commerce.mandate.granted",
  "commerce.mandate.paused",
  "commerce.mandate.resumed",
  "commerce.mandate.revoked",
] as const;

export type PublishedEvent = (typeof PUBLISHED_EVENTS)[number];

/** The rail's answer to one attempt, as the core records it locally and as the API publishes it. */
export const PAYMENT_SUCCEEDED: PublishedEvent = "commerce.payment.succeeded";
export const PAYMENT_FAILED: PublishedEvent = "commerce.payment.failed";
/** The payer's answer to a receivable, as the API publishes it: paid settles, expired and cancelled fail. */
export const CHARGE_PAID: PublishedEvent = "commerce.charge.paid";
export const CHARGE_EXPIRED: PublishedEvent = "commerce.charge.expired";
export const CHARGE_CANCELLED: PublishedEvent = "commerce.charge.cancelled";

export function isPublishedEvent(name: string): name is PublishedEvent {
  return (PUBLISHED_EVENTS as readonly string[]).includes(name);
}
