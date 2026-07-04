/**
 * Published-scenario contract check (per-group completeness).
 *
 * This example must stay in sync with the demo scenarios published in
 * `@codespar/types`. The published `DEMO_SCENARIO_MANIFEST` is the source of
 * truth. Because more than one demo now shares the manifest, the manifest groups
 * scenarios by example, and this example asserts two things against it:
 *
 *   - per-group completeness: the scenarios this example actually drives equal
 *     this example's manifest group exactly — publish a new scenario into this
 *     group and forget to add it here, and this fails CI;
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
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO,
} from "@codespar/types/testing";

// This example's group in the published manifest.
const GROUP = "boleto-expiry-fiscal-remediation";

// Scenarios this example drives end-to-end in skeleton.test.ts.
const DRIVEN = [
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO.name,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO.name,
];

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { devDependencies: Record<string, string> };

describe("published scenario contract", () => {
  it("drives exactly this example's manifest group (per-group completeness)", () => {
    const group = DEMO_SCENARIO_MANIFEST.groups[GROUP];
    expect([...DRIVEN].sort()).toEqual([...group].sort());
  });

  it("pins @codespar/types to an exact version equal to the manifest (version-alignment)", () => {
    const pin = pkg.devDependencies["@codespar/types"];
    expect(pin).toBe(DEMO_SCENARIO_MANIFEST.version);
  });
});
