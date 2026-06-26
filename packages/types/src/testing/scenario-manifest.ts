/* ── Demo scenario manifest ───────────────────────────────────────
 *
 * The published contract for the demo scenarios this package ships: the
 * canonical set of scenario `name`s, grouped by the example that drives them,
 * plus the package version. Tests that drive these scenarios assert against it
 * so an example and the published scenarios cannot silently drift apart:
 *
 *   - Completeness: each example asserts the set of scenarios it actually drives
 *     equals its OWN `groups` entry exactly (per-group completeness). Publish a
 *     new scenario into a group and forget to cover it in that example, and the
 *     assertion fails. The managed side, which drives every scenario in one
 *     suite, asserts against the flat `scenarios` union.
 *
 *   - Version-alignment: a consumer asserts its `@codespar/types` dependency is
 *     an exact pin equal to `version` — a caret/tilde or a stale pin fails, so a
 *     consumer always tracks the exact published scenario set.
 *
 * The flat `scenarios` list is the union of every group, asserted by
 * `scenario-manifest.test.ts` so a scenario added to a group but not the flat
 * list (or vice versa) fails. `version` is kept in lockstep with the package
 * version by the same test — so a publish that forgets to bump the manifest
 * cannot ship.
 *
 * `groups` generalizes the single-example manifest to host more than one
 * dual-runtime demo: each OSS example owns one group and asserts per-group
 * completeness, so a second demo coexists with the first without weakening the
 * "every scenario is covered" guarantee.
 * ─────────────────────────────────────────────────────────────── */

/** The demo-scenario contract: the published package version, the flat scenario
 *  union, and the per-example groups a consumer drives completely. */
export const DEMO_SCENARIO_MANIFEST = {
  /** Must equal this package's published version (see the lockstep test). */
  version: "0.10.15",
  /** Every shipped scenario `name` — the union of all `groups` (see the test). */
  scenarios: [
    "customer-data-rejection",
    "merchant-blocked",
    "boleto-expired-nfe-correction",
    "boleto-expired-nfe-reissue",
  ],
  /** Scenario `name`s grouped by the example that drives them. Each OSS example
   *  asserts it drives exactly its own group (per-group completeness). */
  groups: {
    "payment-failure-triage": ["customer-data-rejection", "merchant-blocked"],
    "boleto-expiry-fiscal-remediation": [
      "boleto-expired-nfe-correction",
      "boleto-expired-nfe-reissue",
    ],
  },
} as const;

/** A manifest scenario name. */
export type DemoScenarioName =
  (typeof DEMO_SCENARIO_MANIFEST)["scenarios"][number];

/** A manifest example/group name. */
export type DemoScenarioGroupName =
  keyof (typeof DEMO_SCENARIO_MANIFEST)["groups"];
