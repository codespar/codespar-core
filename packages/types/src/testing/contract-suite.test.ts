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

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolResult } from "../index.js";
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

/* ── Execute-leg assertion against a FAKE backend ────────────────
 *
 * The execute leg drives `codespar_list_tools` (a built-in that always
 * succeeds) and asserts the canonical no-error result: `error: null`. Prove
 * that assertion bites without a real server by running the registered leg
 * body against a stubbed `fetch` that plays a configurable backend, and
 * capturing pass/fail via a mocked Vitest that runs the `it` body with the
 * real `expect`.
 *
 * A backend that returns `error: null` on the success passes; a backend
 * that returns a non-null error on the success (e.g. the `error: ""` an OSS
 * runtime used to return — the divergence the old `expect.anything()`
 * masked) fails the leg.
 * ─────────────────────────────────────────────────────────────── */

/** The ToolResult a fake backend returns for the execute call. */
type FakeExecuteResult = ToolResult;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub `fetch`: session-create returns an active session, execute returns
 *  the given result, DELETE closes. Returns a teardown. */
function installFakeBackend(executeResult: FakeExecuteResult): () => void {
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/sessions") && init?.method === "POST") {
      return jsonResponse({ id: "sess_fake", status: "active" });
    }
    if (u.includes("/execute")) {
      return jsonResponse(executeResult);
    }
    return jsonResponse({});
  });
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Run only the execute leg under a mocked Vitest that executes the `it`
 *  body with the real `expect`, recording whether it passed. */
async function runExecuteLeg(): Promise<{ passed: boolean; error?: string }> {
  vi.resetModules();
  const cases: Array<() => Promise<void>> = [];
  const afterEachFns: Array<() => unknown> = [];
  const realExpect = (
    await vi.importActual<typeof import("vitest")>("vitest")
  ).expect;

  vi.doMock("vitest", () => ({
    describe: (_name: string, fn: () => void) => fn(),
    it: (_name: string, fn: () => unknown) => {
      cases.push(async () => {
        await fn();
      });
    },
    afterEach: (fn: () => unknown) => {
      afterEachFns.push(fn);
    },
    expect: realExpect,
  }));

  const mod = await import("./contract-suite.js");
  mod.runContractSuite("http://localhost:9999", "csk_test", {
    legs: ["execute"],
  });
  try {
    for (const c of cases) await c();
    return { passed: true };
  } catch (err) {
    return { passed: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const a of afterEachFns) await a();
    vi.doUnmock("vitest");
  }
}

describe("runContractSuite execute leg against a fake backend", () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  const base: Omit<ToolResult, "error"> = {
    success: true,
    data: { tools: [] },
    duration: 3,
    server: "fake-runtime",
    tool: "codespar_list_tools",
  };

  it("passes when a success result carries the canonical error: null", async () => {
    teardown = installFakeBackend({ ...base, error: null });
    const outcome = await runExecuteLeg();
    expect(outcome.error ?? "", outcome.error ?? "").toBe("");
    expect(outcome.passed).toBe(true);
  });

  it("fails when a success result carries a non-null error (the masked divergence)", async () => {
    // An OSS runtime used to return `error: ""` on a success — non-null, so
    // it must now fail the pinned `error: null` assertion.
    teardown = installFakeBackend({ ...base, error: "" });
    const outcome = await runExecuteLeg();
    expect(outcome.passed).toBe(false);
  });

  it("fails when a no-error result reports success: false", async () => {
    // `success: true` is now pinned too — list_tools always succeeds.
    teardown = installFakeBackend({ ...base, success: false, error: null });
    const outcome = await runExecuteLeg();
    expect(outcome.passed).toBe(false);
  });
});
