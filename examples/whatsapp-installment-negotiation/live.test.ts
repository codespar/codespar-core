/**
 * Live LLM smoke — same scenario as `skeleton.test.ts`, but driven by
 * real `api.anthropic.com` instead of `@copilotkit/aimock`. MCP servers
 * still run with `--demo` (no Asaas / Nuvem-Fiscal / Z-API credentials
 * needed), but a real `ANTHROPIC_API_KEY` is required.
 *
 * Catches regressions the aimock-based default `skeleton.test.ts` cannot
 * surface — Anthropic tool-name regex violations, invalid model ids,
 * system-prompt issues that change the agent's behaviour across turns.
 * The trade-off is that real Claude is slower and probabilistic, so the
 * assertions stay coarse (at-least-one Asaas call observed, at-least-one
 * NF-e dispatched, all dispatched tools record `status: "success"`).
 *
 * Real Claude is also rightly cautious on under-specified prompts — it
 * will ask the buyer for clarifying details before issuing tool calls
 * unless the prompt makes the buyer's intent explicit. The prompts
 * below carry the buyer's role, the product, the amount, and an
 * explicit "you are the merchant agent in demo mode" framing so the
 * agent can drive the negotiation in one pass.
 *
 * Run via `npm run validate:live` from this directory with
 * `ANTHROPIC_API_KEY` set. Do NOT run as part of CI — costs real API
 * spend per invocation.
 */

import { afterAll, describe, expect, it } from "vitest";
import { CodeSpar } from "@codespar/sdk";
import type { Session } from "@codespar/sdk";

const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "local";
const CODESPAR_BASE_URL =
  process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";

// Live smoke runs only when `validate-live.sh` sets this env var. The
// default `npm run validate` / `npm test` keeps `CODESPAR_LIVE_SMOKE`
// unset so this test file is a no-op there and the aimock-driven
// `skeleton.test.ts` is the only assertion.
const RUN_LIVE_SMOKE = process.env.CODESPAR_LIVE_SMOKE === "1";

let session: Session | undefined;

describe.skipIf(!RUN_LIVE_SMOKE)("WhatsApp installment negotiation against real Claude", () => {
  it("computes 6x, creates the installment payment, and issues the NF-e through the real chat-loop", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });
    session = await cs.create(`live-installments-${Date.now()}`, {
      servers: ["asaas", "nuvem-fiscal", "z-api"],
    });

    // ── Turn 1 ──────────────────────────────────────────────────
    const r1 = await session.send(
      [
        "You are a merchant agent for a furniture retailer running in",
        "demo mode (--demo on every MCP — never ask for real customer or",
        "fiscal credentials). A buyer (WhatsApp +5511987654321) just",
        "messaged: 'Quero o sofa de R$4.800. Qual a melhor forma de",
        "pagar?' Reply with two payment options: (a) Pix a vista com 8%",
        "de desconto (compute the discounted total yourself) and (b) 12x",
        "no cartao em parcelas iguais (compute the monthly amount).",
        "Reply in Portuguese. Do not call any tool yet.",
      ].join(" "),
    );
    expect(typeof r1.message).toBe("string");

    // ── Turn 2 ──────────────────────────────────────────────────
    const r2 = await session.send(
      [
        "The buyer replied: 'Em 6x cabe?' Use the asaas__get_installments",
        "tool in preview mode (pass value: 4800 and installments: 6, no",
        "id) to compute the 6x credit-card schedule, then quote the",
        "monthly amount back to the buyer in Portuguese. Ask the buyer to",
        "confirm before creating the payment.",
      ].join(" "),
    );
    const previewCalls = r2.tool_calls.filter(
      (tc) => tc.tool_name === "asaas__get_installments",
    );
    expect(previewCalls.length).toBeGreaterThanOrEqual(1);
    for (const tc of previewCalls) {
      expect(tc.status).toBe("success");
    }

    // ── Turn 3 ──────────────────────────────────────────────────
    const r3 = await session.send(
      [
        "The buyer replied: 'Confirma, pode fechar.' Create the actual",
        "installment payment via asaas__create_payment (customer:",
        "cus_demo_buyer_001, billingType: CREDIT_CARD, value: 4800,",
        "dueDate: 2026-07-01, installments: 6, description: 'Sofa 3",
        "lugares — 6x no cartao'), issue an NF-e for the same total via",
        "nuvem-fiscal__create_nfe (use codigo 'produto' and descricao",
        "'Sofa 3 lugares', valor 4800), then send a confirmation message",
        "via z-api__send_text to +5511987654321.",
      ].join(" "),
    );

    const createPaymentCalls = r3.tool_calls.filter(
      (tc) => tc.tool_name === "asaas__create_payment",
    );
    expect(createPaymentCalls.length).toBeGreaterThanOrEqual(1);

    const nfeCalls = r3.tool_calls.filter(
      (tc) => tc.tool_name === "nuvem-fiscal__create_nfe",
    );
    expect(nfeCalls.length).toBeGreaterThanOrEqual(1);
    for (const tc of nfeCalls) {
      expect(tc.status).toBe("success");
      const out = tc.output as { id: string; status: string };
      expect(out.id).toMatch(/^nfe_/);
      expect(out.status).toBe("autorizada");
    }

    // ── No dispatched tool failed across any turn ──
    for (const r of [r1, r2, r3]) {
      for (const tc of r.tool_calls) {
        expect(tc.status).toBe("success");
      }
    }
  }, 300_000);

  afterAll(async () => {
    if (session) {
      try {
        await session.close();
      } catch {
        /* swallow — closing a live session that already timed out is fine */
      }
    }
  });
});
