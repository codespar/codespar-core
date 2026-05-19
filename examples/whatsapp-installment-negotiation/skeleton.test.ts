/**
 * WhatsApp installment negotiation — an LLM-driven multi-turn flow
 * against the OSS MCP bridge using `session.send()`.
 *
 * Three buyer messages in, one Asaas preview call, one Asaas
 * create_payment with installments, one NF-e issued, one WhatsApp
 * outbound carrying the confirmation. The LLM call goes through
 * @copilotkit/aimock (via the runtime's ANTHROPIC_BASE_URL) and the
 * MCP servers run with `--demo` to return deterministic fixtures.
 *
 * Source of truth for the fixture payloads: the three MCP packages
 * with `--demo` on their spawn line in `mcp-servers.json`, plus the
 * aimock fixture file at `./fixtures/aimock-fixtures.json`. The
 * runtime is started separately (see scripts/validate.sh) so its
 * cwd matches this directory and the bridge reads
 * `./mcp-servers.json`.
 *
 * This is the first multi-turn demo in the OSS demo series, and the
 * first that exercises `session.send()` state management across
 * three buyer messages. Establishes the multi-turn aimock fixture
 * pattern downstream demos will reuse.
 */

import { afterAll, describe, expect, it } from "vitest";
import { CodeSpar } from "@codespar/sdk";
import type { Session } from "@codespar/sdk";

// `local` is an OSS sentinel — the self-hosted runtime accepts any
// non-empty Bearer token. Managed mode replaces this with a real
// `csk_test_*` key.
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "local";
const CODESPAR_BASE_URL =
  process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";

let session: Session | undefined;

describe("WhatsApp installment negotiation", () => {
  it("computes a 6x preview, creates the installment payment, issues the NF-e, and confirms via WhatsApp", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });

    session = await cs.create(`installments-${Date.now()}`, {
      servers: ["asaas", "nuvem-fiscal", "z-api"],
    });

    // ── Turn 1: buyer asks payment options ──────────────────────
    const r1 = await session.send(
      "Oi! Quero o sofa de R$4.800 que vi no site. Qual a melhor forma de pagar?",
    );
    expect(typeof r1.message).toBe("string");
    expect(r1.tool_calls).toHaveLength(0);

    // ── Turn 2: buyer asks "what about 6x?" — agent previews via Asaas ──
    const r2 = await session.send("Em 6x da pra fechar?");
    const previewCalls = r2.tool_calls.filter(
      (tc) => tc.tool_name === "asaas__get_installments",
    );
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0]!.status).toBe("success");
    const previewArgs = previewCalls[0]!.input as {
      value?: number;
      installments?: number;
    };
    expect(previewArgs.value).toBe(4800);
    expect(previewArgs.installments).toBe(6);
    const previewOut = previewCalls[0]!.output as {
      preview?: boolean;
      installmentCount?: number;
      installmentValue?: number;
      installments?: Array<{ value: number; status: string }>;
    };
    expect(previewOut.preview).toBe(true);
    expect(previewOut.installmentCount).toBe(6);
    expect(previewOut.installmentValue).toBe(800);
    expect(previewOut.installments).toHaveLength(6);
    expect(previewOut.installments![0]!.status).toBe("PREVIEW");
    expect(typeof r2.message).toBe("string");

    // ── Turn 3: buyer confirms — agent creates payment + NF-e + sends WhatsApp ──
    const r3 = await session.send("Confirma, pode fechar.");

    const createPaymentCalls = r3.tool_calls.filter(
      (tc) => tc.tool_name === "asaas__create_payment",
    );
    expect(createPaymentCalls).toHaveLength(1);
    expect(createPaymentCalls[0]!.status).toBe("success");
    const paymentArgs = createPaymentCalls[0]!.input as {
      billingType: string;
      value: number;
      installments?: number;
    };
    expect(paymentArgs.billingType).toBe("CREDIT_CARD");
    expect(paymentArgs.value).toBe(4800);
    expect(paymentArgs.installments).toBe(6);
    const paymentOut = createPaymentCalls[0]!.output as {
      id: string;
      installments?: number;
      installmentValue?: number;
    };
    expect(paymentOut.id).toMatch(/^pay_demo_/);
    expect(paymentOut.installments).toBe(6);
    expect(paymentOut.installmentValue).toBe(800);

    const nfeCalls = r3.tool_calls.filter(
      (tc) => tc.tool_name === "nuvem-fiscal__create_nfe",
    );
    expect(nfeCalls).toHaveLength(1);
    expect(nfeCalls[0]!.status).toBe("success");
    const nfeOut = nfeCalls[0]!.output as { id: string; status: string };
    expect(nfeOut.id).toMatch(/^nfe_demo_/);
    expect(nfeOut.status).toBe("autorizada");

    const sendCalls = r3.tool_calls.filter(
      (tc) => tc.tool_name === "z-api__send_text",
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const message = (sendCalls[0]!.input as { message: string }).message;
    expect(message).toMatch(/confirm/i);

    // ── Cross-turn: chat-loop iterated at least three times overall ──
    // (turn 0 reply + turn 1 tool_use + turn 2 reply + turn 3 tool_uses + turn 4 reply ≥ 5)
    const totalIterations = r1.iterations + r2.iterations + r3.iterations;
    expect(totalIterations).toBeGreaterThanOrEqual(3);

    // ── Cross-turn: every dispatched tool succeeded ──
    for (const r of [r1, r2, r3]) {
      for (const tc of r.tool_calls) {
        expect(tc.status).toBe("success");
      }
    }
  }, 120_000);

  afterAll(async () => {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort
      }
    }
  });
});
