/**
 * Drift guard for this example's aimock fixtures.
 *
 * validate.sh feeds aimock the checked-in fixtures/aimock-fixtures.json, which
 * must stay identical to the canonical scenarios' `aimockFixtures` exported from
 * @codespar/types/testing. This example runs BOTH boleto scenarios against one
 * aimock instance, so the checked-in file is the concatenation of the two
 * scenarios' fixtures (their match keys are disjoint — the two scenarios match on
 * different order numbers, so one aimock serves both). If the checked-in copy
 * drifts, the demo would replay a different conversation than the scenarios
 * define. This test fails on any such drift; it needs no runtime.
 */
import { describe, it, expect } from "vitest";
import {
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO,
} from "@codespar/types/testing";
import staticFixtures from "./fixtures/aimock-fixtures.json";

type FixtureSet = { fixtures: unknown[] };

describe("aimock fixtures stay in sync with the published scenarios", () => {
  it("static fixtures equal both scenarios' aimockFixtures, concatenated", () => {
    const expected = {
      fixtures: [
        ...(BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO.aimockFixtures as FixtureSet).fixtures,
        ...(BOLETO_EXPIRED_NFE_REISSUE_SCENARIO.aimockFixtures as FixtureSet).fixtures,
      ],
    };
    expect(staticFixtures).toEqual(expected);
  });
});
