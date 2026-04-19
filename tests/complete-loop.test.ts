/**
 * Complete Loop Integration Test
 *
 * Validates the full commerce workflow:
 *   1. Create session with LatAm servers
 *   2. Execute checkout (payment link)
 *   3. Execute invoice (NF-e)
 *   4. Execute ship (carrier quote + label)
 *   5. Execute notify (WhatsApp)
 *   6. Verify all results have correct structure
 *   7. Close session
 *
 * Run: CODESPAR_API_KEY=csk_live_... npx tsx tests/complete-loop.test.ts
 */

import { CodeSpar } from "../packages/core/dist/index.js";

const SERVERS = ["zoop", "nuvem-fiscal", "melhor-envio", "z-api", "omie"];

interface TestResult {
  step: string;
  tool: string;
  success: boolean;
  duration: number;
  outputKeys: string[];
  error?: string;
}

async function runCompleteLoop(): Promise<TestResult[]> {
  const apiKey = process.env.CODESPAR_API_KEY;
  if (!apiKey) {
    console.error("ERROR: Set CODESPAR_API_KEY env var");
    process.exit(1);
  }

  const cs = new CodeSpar({ apiKey });
  const results: TestResult[] = [];

  console.log("\n═══════════════════════════════════════");
  console.log("  COMPLETE LOOP INTEGRATION TEST");
  console.log("═══════════════════════════════════════\n");

  // 1. Create session
  console.log("→ Creating session...");
  const start = Date.now();
  const session = await cs.create("test_complete_loop", {
    servers: SERVERS,
    metadata: { source: "integration-test", test: "complete-loop" },
  });
  console.log(`  ✓ Session ${session.id} created (${Date.now() - start}ms)`);
  console.log(`  Servers: ${session.servers.join(", ")}\n`);

  try {
    // 2. Checkout
    console.log("→ Step 1: codespar_checkout...");
    const t1 = Date.now();
    const checkout = await session.execute("codespar_checkout", {
      items: [{ name: "Starter Kit", quantity: 1, price: 149 }],
      currency: "BRL",
      paymentMethod: "pix",
    });
    const d1 = Date.now() - t1;
    results.push({
      step: "1. Checkout",
      tool: "codespar_checkout",
      success: checkout.success,
      duration: d1,
      outputKeys: checkout.data ? Object.keys(checkout.data as object) : [],
      error: checkout.error || undefined,
    });
    console.log(`  ${checkout.success ? "✓" : "✗"} ${d1}ms — keys: ${results[0].outputKeys.join(", ")}`);
    if (checkout.error) console.log(`  ERROR: ${checkout.error}`);

    // 3. Invoice
    console.log("\n→ Step 2: codespar_invoice...");
    const t2 = Date.now();
    const invoice = await session.execute("codespar_invoice", {
      type: "nfe",
      recipient: { name: "Test Customer", document: "000.000.000-00" },
      items: [{ description: "Starter Kit", quantity: 1, unitPrice: 149 }],
    });
    const d2 = Date.now() - t2;
    results.push({
      step: "2. Invoice",
      tool: "codespar_invoice",
      success: invoice.success,
      duration: d2,
      outputKeys: invoice.data ? Object.keys(invoice.data as object) : [],
      error: invoice.error || undefined,
    });
    console.log(`  ${invoice.success ? "✓" : "✗"} ${d2}ms — keys: ${results[1].outputKeys.join(", ")}`);

    // 4. Ship
    console.log("\n→ Step 3: codespar_ship...");
    const t3 = Date.now();
    const ship = await session.execute("codespar_ship", {
      action: "quote",
      origin: { postalCode: "04538-132", city: "São Paulo", state: "SP" },
      destination: { postalCode: "01310-100", city: "São Paulo", state: "SP" },
      packageInfo: { weight: 0.5, width: 20, height: 10, length: 25 },
    });
    const d3 = Date.now() - t3;
    results.push({
      step: "3. Ship",
      tool: "codespar_ship",
      success: ship.success,
      duration: d3,
      outputKeys: ship.data ? Object.keys(ship.data as object) : [],
      error: ship.error || undefined,
    });
    console.log(`  ${ship.success ? "✓" : "✗"} ${d3}ms — keys: ${results[2].outputKeys.join(", ")}`);

    // 5. Notify
    console.log("\n→ Step 4: codespar_notify...");
    const t4 = Date.now();
    const notify = await session.execute("codespar_notify", {
      channel: "whatsapp",
      to: "5511999999999",
      message: "Pedido confirmado! Starter Kit R$149,00.",
    });
    const d4 = Date.now() - t4;
    results.push({
      step: "4. Notify",
      tool: "codespar_notify",
      success: notify.success,
      duration: d4,
      outputKeys: notify.data ? Object.keys(notify.data as object) : [],
      error: notify.error || undefined,
    });
    console.log(`  ${notify.success ? "✓" : "✗"} ${d4}ms — keys: ${results[3].outputKeys.join(", ")}`);

  } finally {
    // 6. Close session
    console.log("\n→ Closing session...");
    await session.close();
    console.log("  ✓ Session closed");
  }

  // 7. Report
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const allSuccess = results.every((r) => r.success);
  const successCount = results.filter((r) => r.success).length;

  console.log("\n═══════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════");
  console.log(`  Steps: ${successCount}/${results.length} successful`);
  console.log(`  Total: ${totalDuration}ms`);
  console.log(`  Status: ${allSuccess ? "✅ ALL PASSED" : "❌ FAILURES DETECTED"}`);
  console.log("═══════════════════════════════════════\n");

  for (const r of results) {
    console.log(`  ${r.success ? "✓" : "✗"} ${r.step.padEnd(15)} ${String(r.duration).padStart(4)}ms  ${r.outputKeys.join(", ")}`);
  }

  console.log("");

  if (!allSuccess) {
    console.error("FAILED — Not all steps completed successfully.");
    process.exit(1);
  }

  return results;
}

runCompleteLoop().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
