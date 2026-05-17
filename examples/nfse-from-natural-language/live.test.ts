/**
 * Live LLM smoke — same scenario as `skeleton.test.ts`, but driven by
 * real `api.anthropic.com` instead of `@copilotkit/aimock`. MCP servers
 * still run with `--demo` (no Nuvem-Fiscal / Z-API credentials needed),
 * but a real `ANTHROPIC_API_KEY` is required.
 *
 * Catches regressions the aimock-based default `skeleton.test.ts` cannot
 * surface — Anthropic tool-name regex violations, invalid model ids,
 * system-prompt issues that change the agent's behaviour. The trade-off
 * is that real Claude is slower and probabilistic, so the assertions
 * stay coarse (at-least-one NFS-e issuance dispatched, every successful
 * call records `status: "success"`).
 *
 * Real Claude is also rightly cautious on under-specified fiscal
 * prompts — it will ask for prestador / tomador CNPJ, environment,
 * service codes, etc. before issuing documents. The prompt below
 * carries all of that context so the agent can one-shot the flow in
 * demo mode. The aimock fixture in `fixtures/aimock-fixtures.json`
 * gets away with a terser prompt because it is scripted, not reasoned.
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

describe.skipIf(!RUN_LIVE_SMOKE)("Service invoice from natural language against real Claude", () => {
  it("issues NFS-e and delivers via WhatsApp through the real chat-loop", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });
    session = await cs.create(`live-nfse-from-nl-${Date.now()}`, {
      servers: ["nuvem-fiscal", "z-api"],
    });

    const prompt = [
      "Issue two NFS-e in demo / homologação environment and then send",
      "a WhatsApp message back with both PDF URLs.",
      "",
      "Use LC 116/2003 codes — 1.05 (digital content access) for the",
      "platform fee and 17.01 (consultancy and audit) for the consulting fee.",
      "",
      "Customer's WhatsApp number: +5511987654321.",
      "",
      "Line 1: platform access fee, R$2.800,00, service description",
      "'Acesso mensal à plataforma SaaS'.",
      "Line 2: onboarding consulting, R$1.200,00, service description",
      "'Consultoria de onboarding'.",
      "",
      "Don't ask for prestador / tomador identifiers — the system is in",
      "demo mode and the MCP tools accept whatever defaults you pass.",
    ].join(" ");

    const result = await session.send(prompt);

    expect(result.iterations).toBeGreaterThanOrEqual(1);

    // The fiscal spine: at least one create_nfse dispatched, every
    // successful dispatch carries the expected demo-fixture shape.
    // Real Claude may issue both invoices in one turn or two, with or
    // without an explicit WhatsApp delivery — we only insist the
    // NFS-e issuance ran.
    const nfseCalls = result.tool_calls.filter(
      (tc) => tc.tool_name === "nuvem-fiscal__create_nfse",
    );
    expect(nfseCalls.length).toBeGreaterThanOrEqual(1);

    for (const tc of nfseCalls) {
      expect(tc.status).toBe("success");
      const data = tc.output as { id: string; status: string };
      expect(data.id).toMatch(/^nfse_/);
      expect(data.status).toBe("autorizada");
    }

    // No dispatched tool failed.
    for (const tc of result.tool_calls) {
      expect(tc.status).toBe("success");
    }
  }, 180_000);

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
