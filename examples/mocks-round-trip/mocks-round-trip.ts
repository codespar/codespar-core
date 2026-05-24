/**
 * Hosted test-mode mocks round-trip (TypeScript).
 *
 * Demonstrates the two mock shapes accepted by `cs.create({ mocks })`:
 *   - static: a single MockObject returned on every matching call
 *   - stateful: a MockObject[] consumed in order, one per call,
 *     returning `mocks_exhausted` once the list drains
 *
 * Requires a csk_test_* key against a test-environment project — live
 * keys against the same map return `mocks_not_authorized`.
 *
 * Usage:
 *   export CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx
 *   # optional: target a local OSS runtime
 *   # export CODESPAR_BASE_URL=http://localhost:8000
 *   npx tsx mocks-round-trip.ts
 */

import { CodeSpar, CodesparApiError, isMocksExhausted } from "@codespar/sdk";
import type { MockValue } from "@codespar/sdk";

const apiKey = process.env.CODESPAR_API_KEY;
if (!apiKey) {
  console.error("error: set CODESPAR_API_KEY first (csk_test_* recommended)");
  process.exit(1);
}

const fixtures: Record<string, MockValue> = {
  // Static — same response every call
  "asaas/create_customer": {
    id: "cus_test",
    name: "Demo Buyer",
    cpfCnpj: "11144477735",
  },
  // Stateful — consumed in order
  "asaas/create_payment": [
    { id: "pay_1", status: "PENDING", value: 100 },
    { id: "pay_1", status: "RECEIVED", value: 100 },
  ],
};

async function main(): Promise<number> {
  const cs = new CodeSpar({ apiKey });

  let session;
  try {
    session = await cs.create("demo_user", {
      servers: ["asaas"],
      mocks: fixtures,
    });
  } catch (err) {
    if (err instanceof CodesparApiError && err.code === "mocks_not_authorized") {
      console.error(
        "error: this API key cannot use mocks. Swap to a csk_test_* key " +
          "against a test-environment project.",
      );
      return 1;
    }
    throw err;
  }

  try {
    // Static mock
    const customer = await session.execute("asaas/create_customer", {
      name: "Demo Buyer",
      cpfCnpj: "11144477735",
    });
    console.log("customer:", customer.data);

    // First call into the stateful mock
    const pending = await session.execute("asaas/create_payment", {
      customer: "cus_test",
      billingType: "PIX",
      value: 100,
    });
    console.log("payment 1:", pending.data);

    // Second call into the stateful mock — different fixture
    const received = await session.execute("asaas/create_payment", {
      customer: "cus_test",
      billingType: "PIX",
      value: 100,
    });
    console.log("payment 2:", received.data);

    // Third call — list is drained
    const exhausted = await session.execute("asaas/create_payment", {
      customer: "cus_test",
      billingType: "PIX",
      value: 100,
    });
    if (isMocksExhausted(exhausted.data)) {
      console.log("payment 3 drained the list:", exhausted.data.message);
    } else {
      console.log("payment 3:", exhausted.data);
    }
  } finally {
    await session.close();
  }

  return 0;
}

main().then((code) => process.exit(code));
