/**
 * Live LLM smoke — the same two boleto-expiry fiscal scenarios, but driven
 * against real `api.anthropic.com` instead of `@copilotkit/aimock`.
 *
 * "Real Claude, no provider credentials": the runtime still runs in test mode
 * (`CODESPAR_TEST_MODE_ENABLED=true`), so the session `mocks` answer each
 * meta-tool — no Asaas / nfe.io / WhatsApp credentials are needed. What is
 * real is the model: Claude actually reads the `codespar_pay` action=status OVERDUE
 * result and the NF-e's amendment-window state and decides the fiscal remediation
 * (correct in place vs cancel + reissue). That is what the aimock-based
 * `skeleton.test.ts` cannot exercise — Anthropic tool-name regex violations,
 * invalid model ids, and system-prompt regressions that change whether the agent
 * makes the fiscal-state call correctly only surface against the real model.
 *
 * Run via `npm run validate:live` from this directory with `ANTHROPIC_API_KEY`
 * set. Do NOT run as part of CI — costs real API spend and is probabilistic.
 */
import { describe } from "vitest";
import {
  runDemoScenario,
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO,
} from "@codespar/types/testing";

const CODESPAR_BASE_URL = process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "demo";

// Live smoke runs only when `validate-live.sh` sets this env var. The default
// `npm run validate` / `npm test` keeps `CODESPAR_LIVE_SMOKE` unset so this file
// is a no-op there and the aimock-driven `skeleton.test.ts` is the only assertion.
const RUN_LIVE_SMOKE = process.env.CODESPAR_LIVE_SMOKE === "1";

describe.skipIf(!RUN_LIVE_SMOKE)("boleto-expiry fiscal remediation via real Claude (mocked tools)", () => {
  runDemoScenario(CODESPAR_BASE_URL, BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO, { apiKey: CODESPAR_API_KEY });
  runDemoScenario(CODESPAR_BASE_URL, BOLETO_EXPIRED_NFE_REISSUE_SCENARIO, { apiKey: CODESPAR_API_KEY });
});
