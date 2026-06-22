/**
 * Service-invoice demo at the meta-tool abstraction, run against the OSS runtime.
 *
 * The same `SERVICE_INVOICE_SCENARIO` + `runDemoScenario` (from
 * @codespar/types/testing) is consumed unchanged by the managed integration
 * test — proving one fixture set drives both runtimes on the session.send()
 * path. The runtime is booted with this dir's demo-plugin.mjs on CODESPAR_PLUGINS
 * (so the meta-tools exist in the catalog) and aimock on ANTHROPIC_BASE_URL.
 */
import { runDemoScenario, SERVICE_INVOICE_SCENARIO } from "@codespar/types/testing";

const CODESPAR_BASE_URL = process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "demo";

runDemoScenario(CODESPAR_BASE_URL, SERVICE_INVOICE_SCENARIO, { apiKey: CODESPAR_API_KEY });
