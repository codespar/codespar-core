/**
 * Lockstep guard: the demo-scenario manifest's `version` must equal the
 * package's published version, and its `scenarios` must name real, shipped
 * scenarios whose `name` matches.
 *
 * Why this matters: a consumer asserts its `@codespar/types` pin equals
 * `DEMO_SCENARIO_MANIFEST.version`. If a publish bumps the package version but
 * forgets to bump the manifest, the manifest would point at a version nobody
 * pins — silently disarming the version-alignment check. This test fails the
 * publish before that can happen.
 *
 * package.json is read at runtime (not statically imported) so it stays outside
 * the package's `rootDir`/build graph.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEMO_SCENARIO_MANIFEST } from "./scenario-manifest.js";
import { CUSTOMER_DATA_REJECTION_SCENARIO } from "./demo-scenarios/customer-data-rejection.js";
import { MERCHANT_BLOCKED_SCENARIO } from "./demo-scenarios/merchant-blocked.js";

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("demo scenario manifest", () => {
  it("version is in lockstep with the package version", () => {
    expect(DEMO_SCENARIO_MANIFEST.version).toBe(pkg.version);
  });

  it("names exactly the shipped triage scenarios", () => {
    const shipped = [
      CUSTOMER_DATA_REJECTION_SCENARIO.name,
      MERCHANT_BLOCKED_SCENARIO.name,
    ].sort();
    expect([...DEMO_SCENARIO_MANIFEST.scenarios].sort()).toEqual(shipped);
  });
});
