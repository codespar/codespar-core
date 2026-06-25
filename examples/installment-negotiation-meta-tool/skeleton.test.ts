/**
 * Installment-negotiation demo at the meta-tool abstraction.
 *
 * `INSTALLMENT_NEGOTIATION_SCENARIO` + `runDemoScenario` are the canonical
 * scenario and runner published in @codespar/types/testing — the single source
 * of truth this example consumes — exercised over the session.send() path. The
 * runtime is booted with this dir's demo-plugin.mjs on CODESPAR_PLUGINS (so the
 * meta-tools exist in the catalog) and aimock on ANTHROPIC_BASE_URL.
 */
import { runDemoScenario, INSTALLMENT_NEGOTIATION_SCENARIO } from "@codespar/types/testing";

const CODESPAR_BASE_URL = process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "demo";

runDemoScenario(CODESPAR_BASE_URL, INSTALLMENT_NEGOTIATION_SCENARIO, { apiKey: CODESPAR_API_KEY });
