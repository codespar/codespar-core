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

/* ── Leg assertions against a FAKE backend ───────────────────────
 *
 * `runContractSuite` needs a live backend, so the assertions each leg makes
 * are proven here by running the registered leg body against a stubbed
 * `fetch` that plays a configurable backend, under a mocked Vitest that
 * runs the `it` body with the real `expect` and captures pass/fail.
 *
 * Three surfaces are pinned this way:
 *
 *   - the execute leg's canonical no-error result (`error: null`), which an
 *     earlier `expect.anything()` masked;
 *   - the `POST /v1/sessions` 201 body every leg opens with — the SDK builds
 *     its session from `user_id`, `servers` and `created_at`, so a runtime
 *     that returns only `{ id, status }` must fail every leg, not pass on a
 *     session the SDK could not use;
 *   - the `GET /v1/sessions/:id/connections` body — `servers` entries carry
 *     `id` + `connected`, and `tools` is present, because the SDK caches it.
 * ─────────────────────────────────────────────────────────────── */

/** A 201 body a conforming runtime returns for `{ servers: [], user_id: "contract-suite" }`. */
const CREATED_OK = {
  id: "ses_fake",
  status: "active",
  user_id: "contract-suite",
  servers: [] as string[],
  created_at: "2026-09-23T12:00:00.000Z",
};

/** A connections body a conforming runtime returns: one connected server, no tools. */
const CONNECTIONS_OK = {
  servers: [
    {
      id: "asaas",
      name: "Asaas",
      category: "payments",
      country: "BR",
      auth_type: "api_key",
      connected: true,
    },
  ],
  tools: [] as unknown[],
};

const EXECUTE_OK: ToolResult = {
  success: true,
  data: { tools: [] },
  error: null,
  duration: 3,
  server: "fake-runtime",
  tool: "codespar_list_tools",
};

interface FakeBackend {
  create?: { status?: number; body: unknown };
  execute?: ToolResult;
  connections?: { status?: number; body: unknown };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Stub `fetch` with the given backend answers (conforming defaults). Returns a teardown. */
function installFakeBackend(backend: FakeBackend = {}): () => void {
  const create = backend.create ?? { status: 201, body: CREATED_OK };
  const connections = backend.connections ?? { status: 200, body: CONNECTIONS_OK };
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/sessions") && init?.method === "POST") {
      return jsonResponse(create.body, create.status ?? 201);
    }
    if (u.includes("/execute")) {
      return jsonResponse(backend.execute ?? EXECUTE_OK);
    }
    if (u.endsWith("/connections")) {
      return jsonResponse(connections.body, connections.status ?? 200);
    }
    return jsonResponse({});
  });
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Run one leg under a mocked Vitest that executes the `it` body with the
 *  real `expect`, recording whether it passed. */
async function runLeg(
  leg: ContractLeg,
  servers?: string[],
): Promise<{ passed: boolean; error?: string }> {
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
    legs: [leg],
    ...(servers ? { servers } : {}),
  });
  try {
    for (const c of cases) await c();
    return { passed: true };
  } catch (err) {
    return { passed: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    for (const a of afterEachFns) {
      try {
        await a();
      } catch {
        // afterEach closes a session that may never have opened.
      }
    }
    vi.doUnmock("vitest");
  }
}

describe("runContractSuite execute leg against a fake backend", () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it("passes when a success result carries the canonical error: null", async () => {
    teardown = installFakeBackend({ execute: EXECUTE_OK });
    const outcome = await runLeg("execute");
    expect(outcome.error ?? "", outcome.error ?? "").toBe("");
    expect(outcome.passed).toBe(true);
  });

  it("fails when a success result carries a non-null error (the masked divergence)", async () => {
    // An OSS runtime used to return `error: ""` on a success — non-null, so
    // it must now fail the pinned `error: null` assertion.
    teardown = installFakeBackend({ execute: { ...EXECUTE_OK, error: "" } });
    const outcome = await runLeg("execute");
    expect(outcome.passed).toBe(false);
  });

  it("fails when a no-error result reports success: false", async () => {
    // `success: true` is now pinned too — list_tools always succeeds.
    teardown = installFakeBackend({ execute: { ...EXECUTE_OK, success: false } });
    const outcome = await runLeg("execute");
    expect(outcome.passed).toBe(false);
  });
});

describe("runContractSuite pins the POST /v1/sessions 201 body on every leg", () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it("passes on the full body: id, status, user_id, servers, created_at", async () => {
    teardown = installFakeBackend();
    const outcome = await runLeg("close");
    expect(outcome.error ?? "", outcome.error ?? "").toBe("");
    expect(outcome.passed).toBe(true);
  });

  it("fails on a body that carries only { id, status }", async () => {
    // The shape a runtime used to return: the SDK turned it into an Invalid
    // Date and undefined `userId` / `servers`, silently.
    teardown = installFakeBackend({
      create: { body: { id: "ses_fake", status: "active" } },
    });
    const outcome = await runLeg("close");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("user_id");
  });

  it.each(["user_id", "servers", "created_at"] as const)(
    "fails when %s is missing",
    async (field) => {
      const body: Record<string, unknown> = { ...CREATED_OK };
      delete body[field];
      teardown = installFakeBackend({ create: { body } });
      const outcome = await runLeg("execute");
      expect(outcome.passed).toBe(false);
    },
  );

  it("fails when the status code is not 201", async () => {
    teardown = installFakeBackend({ create: { status: 200, body: CREATED_OK } });
    const outcome = await runLeg("execute");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("201");
  });

  it("fails when user_id is not the one the caller posted", async () => {
    teardown = installFakeBackend({ create: { body: { ...CREATED_OK, user_id: "other" } } });
    const outcome = await runLeg("execute");
    expect(outcome.passed).toBe(false);
  });

  it("fails when created_at does not parse as a date", async () => {
    teardown = installFakeBackend({
      create: { body: { ...CREATED_OK, created_at: "not-a-date" } },
    });
    const outcome = await runLeg("execute");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("created_at");
  });

  it("fails when servers drops an id the caller posted", async () => {
    teardown = installFakeBackend({ create: { body: { ...CREATED_OK, servers: [] } } });
    const outcome = await runLeg("execute", ["alpha"]);
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("servers");
  });

  it("passes when servers echoes the posted ids, with or without provisioned extras", async () => {
    teardown = installFakeBackend({
      create: { body: { ...CREATED_OK, servers: ["alpha", "default"] } },
    });
    const outcome = await runLeg("execute", ["alpha"]);
    expect(outcome.error ?? "", outcome.error ?? "").toBe("");
    expect(outcome.passed).toBe(true);
  });
});

describe("runContractSuite connections leg pins the GET /connections body", () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it("passes on { servers: [{ id, connected, ... }], tools: [] }", async () => {
    teardown = installFakeBackend();
    const outcome = await runLeg("connections");
    expect(outcome.error ?? "", outcome.error ?? "").toBe("");
    expect(outcome.passed).toBe(true);
  });

  it("fails when tools is missing", async () => {
    // The SDK assigns `payload.tools` into its tool cache; without it the
    // cache never fills.
    teardown = installFakeBackend({
      connections: { body: { servers: CONNECTIONS_OK.servers } },
    });
    const outcome = await runLeg("connections");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("tools");
  });

  it("fails when a server entry lacks connected", async () => {
    teardown = installFakeBackend({
      connections: { body: { servers: [{ id: "asaas" }], tools: [] } },
    });
    const outcome = await runLeg("connections");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("connected");
  });

  it("fails when the route answers non-2xx instead of returning []", async () => {
    // A runtime without the route used to pass this leg: the old client
    // swallowed the status and returned an empty list.
    teardown = installFakeBackend({
      connections: { status: 404, body: { error: "not_found" } },
    });
    const outcome = await runLeg("connections");
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toContain("404");
  });
});
