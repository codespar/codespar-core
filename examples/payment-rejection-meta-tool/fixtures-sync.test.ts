/**
 * Drift guard for this example's aimock fixtures.
 *
 * validate.sh feeds aimock the checked-in fixtures/aimock-fixtures.json, which
 * must stay identical to the canonical scenario's `aimockFixtures` exported from
 * @codespar/types/testing. If the checked-in copy drifts from the canonical
 * scenario, the demo would replay a different conversation than the scenario
 * defines. This test fails on any such drift; it needs no runtime.
 */
import { describe, it, expect } from "vitest";
import { PAYMENT_REJECTION_SCENARIO } from "@codespar/types/testing";
import staticFixtures from "./fixtures/aimock-fixtures.json";

describe("aimock fixtures stay in sync with the published scenario", () => {
  it("static fixtures equal PAYMENT_REJECTION_SCENARIO.aimockFixtures", () => {
    expect(staticFixtures).toEqual(PAYMENT_REJECTION_SCENARIO.aimockFixtures);
  });
});
