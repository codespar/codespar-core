/**
 * Unit tests for the option-handling surface of the session contract suite.
 *
 * `runContractSuite` registers Vitest cases against a live backend, so it
 * cannot be exercised directly here without a running server. Instead we test
 * the pure helpers that carry all of the option logic — `selectLegs` (leg
 * selection) and `buildSessionCreateBody` (servers passthrough) — plus assert
 * that `runContractSuite` registers only the selected legs by intercepting the
 * `it` registrations through a mocked `vitest` module.
 */

import { describe, it, expect, vi } from "vitest";
import {
  selectLegs,
  buildSessionCreateBody,
  type ContractLeg,
} from "./contract-suite.js";

describe("selectLegs", () => {
  const ALL: ContractLeg[] = ["execute", "send", "sendStream", "connections", "close"];

  it("returns all five legs in declaration order when no opts given", () => {
    expect(selectLegs()).toEqual(ALL);
    expect(selectLegs({})).toEqual(ALL);
    expect(selectLegs({ servers: ["a"] })).toEqual(ALL);
  });

  it("returns exactly the provided subset", () => {
    expect(selectLegs({ legs: ["execute", "connections", "close"] })).toEqual([
      "execute",
      "connections",
      "close",
    ]);
  });

  it("returns a fresh array (does not alias the caller's legs)", () => {
    const input: ContractLeg[] = ["send"];
    const out = selectLegs({ legs: input });
    expect(out).toEqual(["send"]);
    expect(out).not.toBe(input);
  });
});

describe("buildSessionCreateBody", () => {
  it("defaults servers to [] when no opts given", () => {
    expect(buildSessionCreateBody()).toEqual({ servers: [], user_id: "contract-suite" });
    expect(buildSessionCreateBody({})).toEqual({ servers: [], user_id: "contract-suite" });
  });

  it("passes the provided servers list through unchanged", () => {
    expect(buildSessionCreateBody({ servers: ["codespar_shop", "pix"] })).toEqual({
      servers: ["codespar_shop", "pix"],
      user_id: "contract-suite",
    });
  });

  it("leg selection does not affect the posted servers", () => {
    expect(
      buildSessionCreateBody({ servers: ["only"], legs: ["execute"] }),
    ).toEqual({ servers: ["only"], user_id: "contract-suite" });
  });
});

/**
 * Leg-gating end-to-end: import the suite against a mocked `vitest` so that
 * `describe`/`it`/`afterEach` are inert spies. Registering the suite then
 * records which leg names were passed to `it`, which is what a real Vitest
 * run would schedule. This proves the default registers all five and a
 * subset registers only those, without booting a backend.
 */
describe("runContractSuite leg registration", () => {
  async function registeredLegNames(
    opts?: Parameters<
      typeof import("./contract-suite.js").runContractSuite
    >[2],
  ): Promise<string[]> {
    vi.resetModules();
    const names: string[] = [];
    vi.doMock("vitest", () => ({
      describe: (_name: string, fn: () => void) => fn(),
      it: (name: string) => {
        names.push(name);
      },
      afterEach: () => {},
      expect: () => ({}),
    }));
    const mod = await import("./contract-suite.js");
    mod.runContractSuite("https://runtime.example", "csk_test", opts);
    vi.doUnmock("vitest");
    return names;
  }

  it("registers all five legs by default", async () => {
    const names = await registeredLegNames();
    expect(names).toHaveLength(5);
    expect(names.some((n) => n.startsWith("execute()"))).toBe(true);
    expect(names.some((n) => n.startsWith("send()"))).toBe(true);
    expect(names.some((n) => n.startsWith("sendStream()"))).toBe(true);
    expect(names.some((n) => n.startsWith("connections()"))).toBe(true);
    expect(names.some((n) => n.startsWith("close()"))).toBe(true);
  });

  it("registers only the selected legs and skips the rest", async () => {
    const names = await registeredLegNames({ legs: ["execute", "connections", "close"] });
    expect(names).toHaveLength(3);
    expect(names.some((n) => n.startsWith("execute()"))).toBe(true);
    expect(names.some((n) => n.startsWith("connections()"))).toBe(true);
    expect(names.some((n) => n.startsWith("close()"))).toBe(true);
    expect(names.some((n) => n.startsWith("send()"))).toBe(false);
    expect(names.some((n) => n.startsWith("sendStream()"))).toBe(false);
  });
});
