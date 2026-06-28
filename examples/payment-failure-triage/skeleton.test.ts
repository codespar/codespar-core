/**
 * Payment-failure triage at the meta-tool abstraction.
 *
 * Two shared scenarios published in @codespar/types/testing — the single source
 * of truth this example consumes, exercised over the session.send() path. The
 * runtime is booted with this dir's demo-plugin.mjs on CODESPAR_PLUGINS (so the
 * meta-tools exist in the catalog) and aimock on ANTHROPIC_BASE_URL.
 *
 * Beyond the shared `assertMetaToolTrace` parity check, this test pins the
 * triage judgment itself: the customer-data failure routes to ask-the-customer
 * (notify customer, retry, invoice) with NO human escalation; the non-recoverable
 * failure routes to escalate-to-a-human (notify ops, stop) with NO retry, NO
 * invoice, and NO customer message. That is the irreplaceable agent judgment the
 * demo exists to prove — reading the failure category and routing the
 * remediation, not picking a provider.
 */
import { describe, it, expect } from "vitest";
import type { ToolCallRecord } from "@codespar/types";
import {
  driveDemoScenario,
  assertMetaToolTrace,
  CUSTOMER_DATA_REJECTION_SCENARIO,
  MERCHANT_BLOCKED_SCENARIO,
} from "@codespar/types/testing";

const CODESPAR_BASE_URL = process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "demo";

const callsNamed = (name: string, trace: ToolCallRecord[]) =>
  trace.filter((c) => c.tool_name === name);

/** A `codespar_notify` aimed at an internal ops/human channel (escalation). */
function isHumanEscalation(c: ToolCallRecord): boolean {
  if (c.tool_name !== "codespar_notify") return false;
  const input = (c.input ?? {}) as { channel?: unknown; to?: unknown };
  const to = String(input.to ?? "");
  return input.channel === "slack" || to.startsWith("#");
}

/** A `codespar_notify` aimed at the end customer (a phone/WhatsApp recipient). */
function isCustomerMessage(c: ToolCallRecord): boolean {
  if (c.tool_name !== "codespar_notify") return false;
  const input = (c.input ?? {}) as { channel?: unknown; to?: unknown };
  const to = String(input.to ?? "");
  return input.channel === "whatsapp" || to.startsWith("+");
}

describe("payment-failure triage: customer-data category (recoverable)", () => {
  it("asks the customer, retries, invoices — and never escalates to a human", async () => {
    const trace = await driveDemoScenario(CODESPAR_BASE_URL, CUSTOMER_DATA_REJECTION_SCENARIO, {
      apiKey: CODESPAR_API_KEY,
    });

    // Shared parity: every call is a successful meta-tool covering each turn.
    assertMetaToolTrace(trace, CUSTOMER_DATA_REJECTION_SCENARIO);

    // Triage judgment: pay (rejected) -> retry (confirmed) -> invoice.
    expect(callsNamed("codespar_pay", trace)).toHaveLength(2);
    expect(callsNamed("codespar_invoice", trace)).toHaveLength(1);
    expect(callsNamed("codespar_notify", trace).length).toBeGreaterThanOrEqual(1);

    // No human escalation — the customer can fix the input themselves.
    expect(trace.some(isHumanEscalation)).toBe(false);
    expect(trace.some(isCustomerMessage)).toBe(true);
  });
});

describe("payment-failure triage: non-recoverable category", () => {
  it("escalates to a human and stops — no retry, no invoice, no customer message", async () => {
    const trace = await driveDemoScenario(CODESPAR_BASE_URL, MERCHANT_BLOCKED_SCENARIO, {
      apiKey: CODESPAR_API_KEY,
    });

    assertMetaToolTrace(trace, MERCHANT_BLOCKED_SCENARIO);

    // No retry: codespar_pay is called exactly once.
    expect(callsNamed("codespar_pay", trace)).toHaveLength(1);
    // No invoice: a blocked merchant never issues a fiscal document.
    expect(callsNamed("codespar_invoice", trace)).toHaveLength(0);
    // The single notify is a human escalation, never a customer message.
    expect(callsNamed("codespar_notify", trace)).toHaveLength(1);
    expect(trace.some(isHumanEscalation)).toBe(true);
    expect(trace.some(isCustomerMessage)).toBe(false);
  });
});
