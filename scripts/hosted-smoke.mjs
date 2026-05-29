/**
 * Hosted-runtime smoke check.
 *
 * Loaded by .github/workflows/hosted-runtime-smoke.yml on every PR.
 * Imports the published `@codespar/sdk` from a sibling install dir and
 * runs a single mocks round-trip against the wire-compatible runtime
 * hosted at api.codespar.dev (overridable via CODESPAR_BASE_URL).
 *
 * The script is intentionally tiny — one static mock, one execute call,
 * one shape assertion. The point is to catch wire-shape regressions in
 * the published SDK against the live hosted runtime, not to be a broad
 * functional test.
 *
 * Required env:
 *   CODESPAR_API_KEY — a csk_test_* key against a test-environment
 *     project. Live keys against mocks return `mocks_not_permitted`.
 *
 * Optional env:
 *   CODESPAR_BASE_URL — defaults to https://api.codespar.dev. Set when
 *     pointing at a staging or local runtime.
 *   CODESPAR_SDK_DIR — directory containing the installed SDK
 *     (`node_modules/@codespar/sdk`). Defaults to `./_smoke`.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";

const apiKey = process.env.CODESPAR_API_KEY;
if (!apiKey) {
  console.error(
    "error: CODESPAR_API_KEY is not set. Add a csk_test_* key as the " +
      "CODESPAR_HOSTED_TEST_API_KEY repo secret.",
  );
  process.exit(1);
}

const sdkDir = resolve(process.env.CODESPAR_SDK_DIR ?? "_smoke");
const requireFromSdkDir = createRequire(resolve(sdkDir, "package.json"));
const { CodeSpar, CodesparApiError } = requireFromSdkDir("@codespar/sdk");

const FIXTURE = {
  id: "cus_test",
  name: "Smoke Buyer",
  cpfCnpj: "11144477735",
};

async function main() {
  const cs = new CodeSpar({ apiKey });

  let session;
  try {
    session = await cs.create("hosted-runtime-smoke", {
      servers: ["asaas"],
      mocks: { "asaas/create_customer": FIXTURE },
    });
  } catch (err) {
    if (err instanceof CodesparApiError && err.code === "mocks_not_permitted") {
      console.error(
        "error: API key is not a csk_test_* key against a test-environment " +
          "project. Re-mint the CODESPAR_HOSTED_TEST_API_KEY secret.",
      );
      return 1;
    }
    throw err;
  }

  try {
    const result = await session.execute("asaas/create_customer", {
      name: "Smoke Buyer",
      cpfCnpj: "11144477735",
    });

    const got = JSON.stringify(result.data);
    const want = JSON.stringify(FIXTURE);
    if (got !== want) {
      console.error("error: response shape does not match mock fixture");
      console.error("  want:", want);
      console.error("  got: ", got);
      return 1;
    }

    console.log("hosted-runtime smoke OK — mock round-trip matched fixture");
    console.log("  data:", got);
    return 0;
  } finally {
    await session.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("hosted-runtime smoke FAILED:", err);
    process.exit(1);
  },
);
