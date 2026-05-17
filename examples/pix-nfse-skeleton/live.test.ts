/**
 * Live LLM smoke — same flow as `skeleton.test.ts`, but driven by
 * `session.send()` against real `api.anthropic.com` instead of the
 * deterministic `loop()`. MCP servers still run with `--demo` so no
 * Asaas / Nuvem-Fiscal credentials are needed.
 *
 * Catches regressions that the aimock-based default `skeleton.test.ts`
 * cannot surface — Anthropic tool-name regex violations, invalid model
 * ids, system-prompt issues that change the agent's behaviour. The
 * trade-off is that real Claude is slower and probabilistic, so the
 * assertions stay coarse (at-least-one tool call per server, every
 * dispatched call succeeds).
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

describe.skipIf(!RUN_LIVE_SMOKE)("Pix + NFS-e flow via session.send() against real Claude", () => {
  it("orchestrates Asaas customer + Pix charge + QR + Nuvem-Fiscal NFS-e through the agent loop", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });
    session = await cs.create(`live-skeleton-${Date.now()}`, {
      servers: ["asaas", "nuvem-fiscal"],
    });

    const prompt = [
      "Charge a customer R$150 via Pix and then issue an NFS-e for the",
      "same amount.",
      "",
      "Customer: Cliente Demo, CPF 11144477735, email cliente@example.com,",
      "phone +5521995302656.",
      "",
      "NFS-e service description: 'Pix + NFS-e walking skeleton'.",
      "Use LC 116/2003 code 1.05 (digital content access).",
      "",
      "The environment is in demo / homologação mode — the MCP tools accept",
      "default prestador / tomador identifiers for any field you don't have",
      "explicit values for. Don't ask for clarifying details; pick reasonable",
      "Brazilian defaults if the schema requires them.",
      "",
      "Call the tools in this order: create the Asaas customer, charge them",
      "via Pix, fetch the Pix QR code, then issue the NFS-e. Return a short",
      "summary at the end with the IDs.",
    ].join(" ");

    const result = await session.send(prompt);

    // Loop ran at least once — Claude responded.
    expect(result.iterations).toBeGreaterThanOrEqual(1);

    // Spine of the flow: at least one Asaas tool dispatched and at least
    // one Nuvem-Fiscal tool dispatched. Real Claude may pick a slightly
    // different ordering or call a tool extra times — we only insist the
    // two providers were exercised through the bridge.
    const asaasCalls = result.tool_calls.filter(
      (tc) => tc.server_id === "asaas",
    );
    const nfeCalls = result.tool_calls.filter(
      (tc) => tc.server_id === "nuvem-fiscal",
    );
    expect(asaasCalls.length).toBeGreaterThanOrEqual(1);
    expect(nfeCalls.length).toBeGreaterThanOrEqual(1);

    // No tool dispatch failed — the bridge wire contract held up under a
    // real model's tool_input shape (the cases unit tests can't anticipate).
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
