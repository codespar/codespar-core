/**
 * Published-scenario contract check.
 *
 * This example must stay in sync with the demo scenarios published in
 * `@codespar/types`. The published `DEMO_SCENARIO_MANIFEST` is the source of
 * truth, and this example asserts two things against it:
 *
 *   - completeness: the scenarios this example actually drives equal the
 *     manifest's `scenarios` exactly — publish a new scenario and forget to add
 *     it here, and this fails CI;
 *   - version-alignment: this example's `@codespar/types` dependency is an EXACT
 *     pin equal to the manifest's `version` — a caret/tilde or a stale pin fails,
 *     so the example always tracks the exact published scenario set.
 *
 * Needs no runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEMO_SCENARIO_MANIFEST,
  CUSTOMER_DATA_REJECTION_SCENARIO,
  MERCHANT_BLOCKED_SCENARIO,
} from "@codespar/types/testing";

// Scenarios this example drives end-to-end in skeleton.test.ts.
const DRIVEN = [CUSTOMER_DATA_REJECTION_SCENARIO.name, MERCHANT_BLOCKED_SCENARIO.name];

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { devDependencies: Record<string, string> };

describe("published scenario contract", () => {
  it("drives exactly the manifest's scenarios (completeness)", () => {
    expect([...DRIVEN].sort()).toEqual([...DEMO_SCENARIO_MANIFEST.scenarios].sort());
  });

  it("pins @codespar/types to an exact version equal to the manifest (version-alignment)", () => {
    const pin = pkg.devDependencies["@codespar/types"];
    expect(pin).toBe(DEMO_SCENARIO_MANIFEST.version);
  });
});
