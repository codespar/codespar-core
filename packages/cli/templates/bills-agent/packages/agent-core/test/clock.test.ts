import { describe, expect, it } from "vitest";
import { FIXED_CLOCK_ENV, InvalidFixedClockError, fixedClock, resolveFixedClock } from "../src/clock.js";

describe("fixedClock", () => {
  it("starts at the instant and ticks one second per read, so no two events share a timestamp", () => {
    const clock = fixedClock("2026-09-23T14:00:00-03:00");
    expect(clock().toISOString()).toBe("2026-09-23T17:00:00.000Z");
    expect(clock().toISOString()).toBe("2026-09-23T17:00:01.000Z");
    expect(clock().toISOString()).toBe("2026-09-23T17:00:02.000Z");
  });

  it("refuses what Date cannot parse, and a bare date, naming the source", () => {
    expect(() => fixedClock("yesterday")).toThrow(InvalidFixedClockError);
    expect(() => fixedClock("2026-09-23", FIXED_CLOCK_ENV)).toThrow(/CODESPAR_AGENT_NOW must be an ISO 8601 instant/);
  });
});

describe("resolveFixedClock", () => {
  it("prefers the flag, falls back to the environment, and is undefined (the wall clock) without either", () => {
    expect(resolveFixedClock(undefined, {})).toBeUndefined();
    expect(resolveFixedClock(undefined, { [FIXED_CLOCK_ENV]: "   " })).toBeUndefined();
    expect(resolveFixedClock(undefined, { [FIXED_CLOCK_ENV]: "2026-09-23T20:08:00-03:00" })!().toISOString()).toBe("2026-09-23T23:08:00.000Z");
    expect(resolveFixedClock("2026-09-23T14:00:00-03:00", { [FIXED_CLOCK_ENV]: "2026-09-23T20:08:00-03:00" })!().toISOString()).toBe("2026-09-23T17:00:00.000Z");
  });
});
