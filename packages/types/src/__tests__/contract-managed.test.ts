/**
 * Managed backend contract test.
 *
 * Runs only when CONTRACT_API_KEY is set in the environment. The managed
 * CI leg that activates this file requires four backend prerequisites to be
 * confirmed before it is enabled in ci.yml — see issue #5 for the checklist.
 */

import { describe, it } from "vitest";
import { runContractSuite } from "../testing/contract-suite.js";

const CONTRACT_API_KEY = process.env["CONTRACT_API_KEY"];
const CONTRACT_BASE_URL =
  process.env["CONTRACT_BASE_URL"] ?? "https://api.codespar.dev";

// describeIf gates the entire suite on the presence of CONTRACT_API_KEY.
// When the env var is absent the suite is registered but all tests are
// skipped, so `vitest run` still exits 0 in environments that have no
// managed backend access.
const describeIf = CONTRACT_API_KEY ? describe : describe.skip;

describeIf("managed backend contract", () => {
  it("runContractSuite registers and passes all contract cases", () => {
    // runContractSuite itself calls describe/it internally — we invoke it
    // from inside a describe block so vitest scopes the nested tests here.
    runContractSuite(CONTRACT_BASE_URL, CONTRACT_API_KEY!);
  });
});
