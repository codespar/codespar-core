/**
 * Boleto-expiry fiscal remediation at the meta-tool abstraction.
 *
 * Two shared scenarios published in @codespar/types/testing — the single source
 * of truth this example consumes, exercised over the session.send() path. The
 * runtime is booted with this dir's demo-plugin.mjs on CODESPAR_PLUGINS (so the
 * meta-tools exist in the catalog) and aimock on ANTHROPIC_BASE_URL.
 *
 * Beyond the shared `assertMetaToolTrace` parity check, this test pins the
 * post-purchase judgment itself: from the SAME discovered boleto state (a
 * `codespar_payment_status` query returning OVERDUE), the agent reads the NF-e's
 * fiscal state and routes opposite remediations — a correction (CC-e) in place
 * when the amendment window is open (the NF-e is never cancelled), or a cancel +
 * reissue as a substitute when it is closed. Both branches break the news to the
 * customer collaboratively, never accusatorially, and offer a fresh Pix. That
 * fiscal-state judgment — and the tactful communication — is the irreplaceable
 * agent value the demo exists to prove.
 */
import { describe, it, expect } from "vitest";
import type { ToolCallRecord } from "@codespar/types";
import {
  driveDemoScenario,
  assertMetaToolTrace,
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO,
} from "@codespar/types/testing";

const CODESPAR_BASE_URL = process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "demo";

const callsNamed = (name: string, trace: ToolCallRecord[]) =>
  trace.filter((c) => c.tool_name === name);

/** The `action` field on a `codespar_invoice` call's input. */
function invoiceAction(c: ToolCallRecord): string {
  const input = (c.input ?? {}) as { action?: unknown };
  return typeof input.action === "string" ? input.action : "issue";
}

/** A customer-facing `codespar_notify` (a phone/WhatsApp recipient). */
function customerMessages(trace: ToolCallRecord[]): string[] {
  return trace
    .filter((c) => {
      if (c.tool_name !== "codespar_notify") return false;
      const input = (c.input ?? {}) as { channel?: unknown; to?: unknown };
      const to = String(input.to ?? "");
      return input.channel === "whatsapp" || to.startsWith("+");
    })
    .map((c) => String(((c.input ?? {}) as { message?: unknown }).message ?? ""));
}

// Accusatory phrasing the collaborative message must avoid: it must not blame
// the customer ("you didn't pay", "your fault", "you failed to ...").
const ACCUSATORY = [
  /voc[eê]\s+n[aã]o\s+pagou/i,
  /culpa\s+sua/i,
  /voc[eê]\s+deixou\s+de/i,
  /you\s+did\s+not\s+pay/i,
  /your\s+fault/i,
];
// Collaborative phrasing signalling the agent is resolving the situation.
const COLLABORATIVE = [
  /eu\s+(cuido|organizo|resolvo|vou)/i,
  /sem\s+problema/i,
  /tranquilo/i,
  /j[aá]\s+vou/i,
];

function assertCollaborativeNotAccusatory(messages: string[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const msg of messages) {
    for (const bad of ACCUSATORY) {
      expect(bad.test(msg), `accusatory phrasing in "${msg}"`).toBe(false);
    }
    expect(
      COLLABORATIVE.some((good) => good.test(msg)),
      `message is not visibly collaborative: "${msg}"`,
    ).toBe(true);
  }
}

describe("boleto-expiry fiscal remediation: amendment window open (correct in place)", () => {
  it("discovers the expired boleto, corrects the NF-e in place, never cancels, offers a fresh Pix", async () => {
    const trace = await driveDemoScenario(CODESPAR_BASE_URL, BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO, {
      apiKey: CODESPAR_API_KEY,
    });

    // Shared parity: every call is a successful meta-tool covering each turn.
    assertMetaToolTrace(trace, BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO);

    // Discovery: the agent queried the payment status.
    expect(callsNamed("codespar_payment_status", trace)).toHaveLength(1);

    // Fiscal judgment: invoice is read (status) then corrected (amend) — never
    // an issue-from-scratch, and never a cancel.
    const invoiceActions = callsNamed("codespar_invoice", trace).map(invoiceAction);
    expect(invoiceActions).toContain("status");
    expect(invoiceActions).toContain("amend");

    // A fresh Pix is offered for the same order.
    expect(callsNamed("codespar_pay", trace)).toHaveLength(1);

    // The customer message is collaborative, not accusatory.
    assertCollaborativeNotAccusatory(customerMessages(trace));
  });
});

describe("boleto-expiry fiscal remediation: amendment window closed (cancel + reissue)", () => {
  it("discovers the same expired boleto, cancels + reissues the NF-e, offers a fresh Pix", async () => {
    const trace = await driveDemoScenario(CODESPAR_BASE_URL, BOLETO_EXPIRED_NFE_REISSUE_SCENARIO, {
      apiKey: CODESPAR_API_KEY,
    });

    assertMetaToolTrace(trace, BOLETO_EXPIRED_NFE_REISSUE_SCENARIO);

    expect(callsNamed("codespar_payment_status", trace)).toHaveLength(1);

    // Fiscal judgment: same status read, but the amend cancels + reissues.
    const invoiceActions = callsNamed("codespar_invoice", trace).map(invoiceAction);
    expect(invoiceActions).toContain("status");
    expect(invoiceActions).toContain("amend");

    expect(callsNamed("codespar_pay", trace)).toHaveLength(1);

    // Same collaborative, non-accusatory communication standard.
    assertCollaborativeNotAccusatory(customerMessages(trace));
  });
});
