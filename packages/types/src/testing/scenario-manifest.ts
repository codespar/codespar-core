/* ── Demo scenario manifest ───────────────────────────────────────
 *
 * The published contract for the demo scenarios this package ships: the
 * canonical set of scenario `name`s plus the package version. A test that drives
 * these scenarios asserts against it so an example and the published scenarios
 * cannot silently drift apart:
 *
 *   - Completeness: a consumer asserts the set of scenarios it actually drives
 *     equals `scenarios` exactly. Publish a new scenario and forget to cover it,
 *     and the assertion fails.
 *
 *   - Version-alignment: a consumer asserts its `@codespar/types` dependency is
 *     an exact pin equal to `version` — a caret/tilde or a stale pin fails, so a
 *     consumer always tracks the exact published scenario set.
 *
 * `version` is kept in lockstep with the package version by
 * `scenario-manifest.test.ts`, which fails CI if they drift — so a publish that
 * forgets to bump the manifest cannot ship.
 * ─────────────────────────────────────────────────────────────── */

/** The demo-scenario contract: the published package version plus the scenario
 *  names a consumer of these scenarios must drive completely. */
export const DEMO_SCENARIO_MANIFEST = {
  /** Must equal this package's published version (see the lockstep test). */
  version: "0.10.13",
  /** Scenario `name`s a consumer must drive, exactly. */
  scenarios: ["customer-data-rejection", "merchant-blocked"],
} as const;

/** A manifest scenario name. */
export type DemoScenarioName =
  (typeof DEMO_SCENARIO_MANIFEST)["scenarios"][number];
