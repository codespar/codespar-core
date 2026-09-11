/**
 * The published AgenticReceipt is the receipt the server actually returns
 * (oss-sdk#13).
 *
 * `AgenticReceipt` is what an SDK consumer types a `codespar_ledger
 * action=receipt` response as. The enterprise API's `receiptRowToJson`
 * (packages/api/src/agentic-receipt.ts) emits six fields under `payment` that
 * this interface did not declare: the atomic amount every receipt carries, the
 * three-amount metered contract, the metering basis, and the sandbox marker.
 *
 * A consumer therefore could not read them without an `as any`, and TypeScript
 * would flag them as excess on any literal — which is what this file asserts.
 * The fixture below is the emitted shape, field for field; `satisfies` is the
 * assertion, so the compiler fails the build if the published type ever narrows
 * away from what the server sends.
 *
 * This does not change a byte of what the server emits, and it must not: the
 * receipt is sealed and signed, so "aligning the JSON with the type" would
 * break `chain` and `receipt_sig`. The type moves; the wire does not.
 */
import { describe, expect, it } from "vitest";

import type { AgenticReceipt } from "./types.js";

/** A metered card receipt: every optional field present at once. */
const metered = {
  receipt_id: "rcp_01J0",
  state: "delivered",
  mandate: {
    id: "mnd_01J0",
    nonce: "n_01",
    scope: "compute",
    currency: "USD",
    sig: "sig_mandate",
  },
  quote: {
    seller: "acme",
    resource: "gpu-hour",
    price_minor: 1200,
    payee: "acme",
    session_id: "ses_01",
    sig: "sig_quote",
    at: "2026-08-01T00:00:00.000Z",
  },
  payment: {
    rail: "usdc-onchain",
    provider: "bridge",
    tx_id: "0xabc",
    amount_minor: 1200,
    // The six the enterprise API emits and the published type did not declare.
    amount_atomic: "12000000",
    amount_authorized: "15000000",
    amount_charged: "12000000",
    amount_refunded: "3000000",
    metering: { basis: "tokens", units: "40000", unit_price: "300" },
    sandbox: true,
    attempt_id: "att_01",
    money_moved: true,
    at: "2026-08-01T00:00:01.000Z",
  },
  delivery: {
    result: "confirmed",
    proof: "https://acme.test/receipt/1",
    kind: "resource",
    nfe_chave: null,
    at: "2026-08-01T00:00:02.000Z",
  },
  chain: "e3b0c44298fc1c14",
  receipt_sig: "sig_receipt",
  exceptions: [],
} satisfies AgenticReceipt;

/** A fiat receipt carries the atomic amount as null and none of the rest. */
const fiat = {
  ...metered,
  payment: {
    rail: "pix",
    provider: "celcoin",
    tx_id: "E12345",
    amount_minor: 4990,
    amount_atomic: null,
    attempt_id: "att_02",
    money_moved: true,
    at: "2026-08-01T00:00:01.000Z",
  },
} satisfies AgenticReceipt;

describe("AgenticReceipt payment surface", () => {
  it("carries the metered contract through a JSON round trip", () => {
    const parsed = JSON.parse(JSON.stringify(metered)) as AgenticReceipt;
    expect(parsed.payment.amount_atomic).toBe("12000000");
    expect(parsed.payment.amount_authorized).toBe("15000000");
    expect(parsed.payment.amount_charged).toBe("12000000");
    expect(parsed.payment.amount_refunded).toBe("3000000");
    expect(parsed.payment.metering).toEqual({
      basis: "tokens",
      units: "40000",
      unit_price: "300",
    });
    expect(parsed.payment.sandbox).toBe(true);
  });

  it("leaves a fiat receipt's payment record exactly as the server sends it", () => {
    // Control: the optional fields are genuinely optional, so the shape a
    // non-metered fiat rail emits still types. Without this, declaring the six
    // as required would pass the test above and break every Pix receipt.
    expect(Object.keys(fiat.payment).sort()).toEqual([
      "amount_atomic",
      "amount_minor",
      "at",
      "attempt_id",
      "money_moved",
      "provider",
      "rail",
      "tx_id",
    ]);
  });
});
