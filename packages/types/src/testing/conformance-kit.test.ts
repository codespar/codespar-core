/**
 * Unit tests for the meta-tool conformance kit.
 *
 * The kit's value is its pass/fail logic: a conforming implementation
 * passes, and an implementation that violates a wire shape, an action-state
 * rule, or an error rule fails — with a violation naming the specific
 * breach. We prove that two ways without a real backend:
 *
 *   1. The pure verification core (`checkWireShape`, `checkActionResult`,
 *      `checkUnregisteredError`, `checkMalformedError`) is exercised
 *      directly against hand-built conforming and violating envelopes.
 *   2. The live suite (`runMetaToolConformanceSuite`) is run end-to-end
 *      against a FAKE backend (a stubbed `fetch`), asserting that a
 *      conforming fake registers passing cases and a fake that breaks each
 *      rule registers a failing case carrying the right violation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolResult } from "../index.js";
import { SHOP_CONTRACT, DISCOVER_CONTRACT } from "../meta-tool-contract.js";
import {
  fieldMatches,
  checkWireShape,
  checkActionResult,
  checkUnregisteredError,
  checkMalformedError,
  formatViolations,
  type Violation,
} from "./conformance-kit.js";

/* ── fieldMatches ────────────────────────────────────────────── */

describe("fieldMatches", () => {
  it("matches each JSON-value kind", () => {
    expect(fieldMatches({ name: "x", kind: "string" }, "a")).toBe(true);
    expect(fieldMatches({ name: "x", kind: "number" }, 1)).toBe(true);
    expect(fieldMatches({ name: "x", kind: "boolean" }, true)).toBe(true);
    expect(fieldMatches({ name: "x", kind: "array" }, [])).toBe(true);
    expect(fieldMatches({ name: "x", kind: "object" }, {})).toBe(true);
  });

  it("rejects mismatched kinds", () => {
    expect(fieldMatches({ name: "x", kind: "string" }, 1)).toBe(false);
    expect(fieldMatches({ name: "x", kind: "number" }, "1")).toBe(false);
    expect(fieldMatches({ name: "x", kind: "array" }, {})).toBe(false);
    expect(fieldMatches({ name: "x", kind: "object" }, [])).toBe(false);
    expect(fieldMatches({ name: "x", kind: "object" }, null)).toBe(false);
  });

  it("constrains string-enum to the closed value set", () => {
    const rule = {
      name: "status",
      kind: "string-enum" as const,
      values: ["in_progress", "ready_for_payment"],
    };
    expect(fieldMatches(rule, "ready_for_payment")).toBe(true);
    expect(fieldMatches(rule, "canceled")).toBe(false);
    expect(fieldMatches(rule, 1)).toBe(false);
  });
});

/* ── checkWireShape ──────────────────────────────────────────── */

describe("checkWireShape", () => {
  const shape = {
    name: "ShopSearchResult",
    fields: [
      { name: "rail", kind: "string" as const },
      { name: "products", kind: "array" as const },
    ],
  };

  it("passes a conforming object", () => {
    expect(checkWireShape(shape, { rail: "vtex", products: [] })).toEqual([]);
  });

  it("allows extra optional fields beyond the shape (subset-shape)", () => {
    expect(
      checkWireShape(shape, { rail: "vtex", products: [], extra: 7 }),
    ).toEqual([]);
  });

  it("flags a missing required field with the field name", () => {
    const violations = checkWireShape(shape, { rail: "vtex" });
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("wire-shape");
    expect(violations[0].detail).toContain("ShopSearchResult.products");
    expect(violations[0].detail).toContain("missing");
  });

  it("flags a wrong-typed field with expected vs got", () => {
    const violations = checkWireShape(shape, { rail: 7, products: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain("ShopSearchResult.rail");
    expect(violations[0].detail).toContain("expected string");
  });

  it("flags a non-object as a single violation", () => {
    expect(checkWireShape(shape, "nope")[0].detail).toContain(
      "expected an object",
    );
    expect(checkWireShape(shape, [])[0].detail).toContain("expected an object");
  });

  it("skips an absent optional field", () => {
    const optShape = {
      name: "S",
      fields: [{ name: "maybe", kind: "string" as const, required: false }],
    };
    expect(checkWireShape(optShape, {})).toEqual([]);
  });
});

/* ── checkActionResult ───────────────────────────────────────── */

function okResult(data: unknown): ToolResult {
  return {
    success: true,
    data,
    error: "",
    duration: 1,
    server: "fake",
    tool: "codespar_shop",
  };
}

function errResult(error: string): ToolResult {
  return {
    success: false,
    data: {},
    error,
    duration: 0,
    server: "fake",
    tool: "codespar_shop",
  };
}

describe("checkActionResult", () => {
  it("passes a conforming shop search result", () => {
    const result = okResult({ rail: "vtex", products: [] });
    expect(checkActionResult(SHOP_CONTRACT, "search", result)).toEqual([]);
  });

  it("flags a checkout result whose status is outside the enum", () => {
    // checkout must return status "in_progress" only.
    const result = okResult({
      checkout_session_id: "cks_1",
      status: "ready_for_payment",
    });
    const violations = checkActionResult(SHOP_CONTRACT, "checkout", result);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("wire-shape");
    expect(violations[0].detail).toContain("status");
    expect(violations[0].detail).toContain("in_progress");
  });

  it("passes the terminal ready_for_payment checkout_status", () => {
    const result = okResult({
      checkout_session_id: "cks_1",
      status: "ready_for_payment",
    });
    expect(
      checkActionResult(SHOP_CONTRACT, "checkout_status", result),
    ).toEqual([]);
  });

  it("flags a checkout_status whose status is not a known state", () => {
    const result = okResult({
      checkout_session_id: "cks_1",
      status: "exploded",
    });
    const violations = checkActionResult(
      SHOP_CONTRACT,
      "checkout_status",
      result,
    );
    expect(violations[0].detail).toContain("status");
  });

  it("flags a success-expected action that returned an error", () => {
    const violations = checkActionResult(
      SHOP_CONTRACT,
      "search",
      errResult("boom"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe("action-state");
    expect(violations[0].detail).toContain("boom");
  });

  it("flags an action that is not in the state machine", () => {
    const violations = checkActionResult(
      SHOP_CONTRACT,
      "teleport",
      okResult({}),
    );
    expect(violations[0].code).toBe("action-state");
    expect(violations[0].detail).toContain("teleport");
  });
});

/* ── error rules ─────────────────────────────────────────────── */

describe("checkUnregisteredError", () => {
  it("passes the canonical 'Tool not registered' envelope", () => {
    const result = errResult("Tool not registered: codespar_shop__probe");
    expect(checkUnregisteredError(SHOP_CONTRACT, result)).toEqual([]);
  });

  it("flags a success result where an unregistered error was due", () => {
    const violations = checkUnregisteredError(SHOP_CONTRACT, okResult({}));
    expect(violations[0].code).toBe("error-unregistered");
    expect(violations[0].detail).toContain("success result");
  });

  it("flags the wrong error message", () => {
    const violations = checkUnregisteredError(
      SHOP_CONTRACT,
      errResult("404: not found"),
    );
    expect(violations[0].code).toBe("error-unregistered");
    expect(violations[0].detail).toContain("Tool not registered");
  });
});

describe("checkMalformedError", () => {
  it("passes a typed error envelope", () => {
    expect(
      checkMalformedError(SHOP_CONTRACT, errResult("query: required")),
    ).toEqual([]);
  });

  it("flags a success result for malformed input", () => {
    const violations = checkMalformedError(SHOP_CONTRACT, okResult({}));
    expect(violations[0].code).toBe("error-malformed");
    expect(violations[0].detail).toContain("success result");
  });

  it("flags an empty error string", () => {
    const violations = checkMalformedError(SHOP_CONTRACT, errResult(""));
    expect(violations[0].code).toBe("error-malformed");
  });
});

describe("formatViolations", () => {
  it("renders 'no violations' for an empty list", () => {
    expect(formatViolations([])).toBe("no violations");
  });

  it("joins violations with their codes", () => {
    const vs: Violation[] = [
      { code: "wire-shape", detail: "a" },
      { code: "action-state", detail: "b" },
    ];
    expect(formatViolations(vs)).toBe("[wire-shape] a; [action-state] b");
  });
});

/* ── Live suite against a FAKE backend ───────────────────────────
 *
 * Drive `runMetaToolConformanceSuite` with a stubbed `fetch` that plays a
 * configurable fake backend, and capture which registered cases pass or
 * fail by running each registered `it` body through a mocked Vitest. A
 * conforming fake → every case passes; a fake that breaks one rule → the
 * matching case fails with the right violation text.
 * ─────────────────────────────────────────────────────────────── */

/** A fake backend: maps `execute(tool, input)` to the ToolResult it returns. */
type FakeExecute = (tool: string, input: Record<string, unknown>) => ToolResult;

/** Install a `fetch` stub that routes session-create/execute/delete to a
 *  fake backend's `execute`. Returns a teardown. */
function installFakeBackend(execute: FakeExecute): () => void {
  const stub = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/v1/sessions") && init?.method === "POST") {
      return jsonResponse({ id: "sess_fake", status: "active" });
    }
    if (u.includes("/execute")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tool: string;
        input: Record<string, unknown>;
      };
      return jsonResponse(execute(body.tool, body.input ?? {}));
    }
    // DELETE close
    return jsonResponse({});
  });
  const original = globalThis.fetch;
  globalThis.fetch = stub as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Run the suite under a mocked Vitest that executes each registered `it`
 *  body and records pass/fail (a thrown/rejected assertion = fail). Returns
 *  one entry per registered case. */
async function runSuiteAndCollect(
  tool: Parameters<
    typeof import("./conformance-kit.js").runMetaToolConformanceSuite
  >[2]["tool"],
): Promise<Array<{ name: string; passed: boolean; error?: string }>> {
  vi.resetModules();
  const cases: Array<() => Promise<{ name: string; passed: boolean; error?: string }>> =
    [];
  const afterEachFns: Array<() => unknown> = [];

  // Real expect so assertions actually fire inside the case bodies.
  const realExpect = (
    await vi.importActual<typeof import("vitest")>("vitest")
  ).expect;

  vi.doMock("vitest", () => ({
    describe: (_name: string, fn: () => void) => fn(),
    it: (name: string, fn: () => unknown) => {
      cases.push(async () => {
        try {
          await fn();
          return { name, passed: true };
        } catch (err) {
          return {
            name,
            passed: false,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          for (const a of afterEachFns) await a();
        }
      });
    },
    afterEach: (fn: () => unknown) => {
      afterEachFns.push(fn);
    },
    expect: realExpect,
  }));

  const mod = await import("./conformance-kit.js");
  mod.runMetaToolConformanceSuite("http://localhost:9999", "csk_test", { tool });
  const results = [];
  for (const c of cases) results.push(await c());
  vi.doUnmock("vitest");
  return results;
}

/** A fully conforming fake backend for codespar_shop. */
const conformingShop: FakeExecute = (tool, input) => {
  if (tool.endsWith("__unregistered_probe")) {
    return errResult(`Tool not registered: ${tool}`);
  }
  const action = input.action;
  // Malformed: search with no query.
  if (action === "search" && !input.query) {
    return errResult("query: required");
  }
  if (action === "search") return okResult({ rail: "vtex", products: [] });
  if (action === "checkout") {
    return okResult({ checkout_session_id: "cks_1", status: "in_progress" });
  }
  if (action === "checkout_status") {
    return okResult({
      checkout_session_id: "cks_1",
      status: "ready_for_payment",
    });
  }
  return errResult("unknown action");
};

describe("runMetaToolConformanceSuite against a fake backend", () => {
  let teardown: (() => void) | null = null;
  afterEach(() => {
    teardown?.();
    teardown = null;
  });

  it("a conforming fake passes every registered case", async () => {
    teardown = installFakeBackend(conformingShop);
    const results = await runSuiteAndCollect("codespar_shop");
    const failures = results.filter((r) => !r.passed);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    // Sanity: it actually registered cases (3 actions + 2 error legs).
    expect(results.length).toBe(5);
  });

  it("fails the wire-shape case when an action returns the wrong shape", async () => {
    // search returns a number for `rail` — a wire-shape violation.
    teardown = installFakeBackend((tool, input) =>
      input.action === "search" && input.query
        ? okResult({ rail: 7, products: [] })
        : conformingShop(tool, input),
    );
    const results = await runSuiteAndCollect("codespar_shop");
    const searchCase = results.find((r) => r.name.includes('"search"'));
    expect(searchCase?.passed).toBe(false);
    expect(searchCase?.error).toContain("ShopSearchResult.rail");
  });

  it("fails the action-state case when checkout reports a terminal status early", async () => {
    teardown = installFakeBackend((tool, input) =>
      input.action === "checkout"
        ? okResult({ checkout_session_id: "cks_1", status: "ready_for_payment" })
        : conformingShop(tool, input),
    );
    const results = await runSuiteAndCollect("codespar_shop");
    const checkoutCase = results.find((r) => r.name.includes('"checkout"'));
    expect(checkoutCase?.passed).toBe(false);
    expect(checkoutCase?.error).toContain("status");
  });

  it("fails the unregistered-error case when the runtime swallows it", async () => {
    teardown = installFakeBackend((tool, input) =>
      tool.endsWith("__unregistered_probe")
        ? okResult({ rail: "vtex", products: [] }) // wrongly succeeds
        : conformingShop(tool, input),
    );
    const results = await runSuiteAndCollect("codespar_shop");
    const unregCase = results.find((r) => r.name.includes("unregistered"));
    expect(unregCase?.passed).toBe(false);
    expect(unregCase?.error).toContain("error-unregistered");
  });

  it("fails the malformed-error case when the runtime accepts bad input", async () => {
    teardown = installFakeBackend((tool, input) =>
      input.action === "search" && !input.query
        ? okResult({ rail: "vtex", products: [] }) // wrongly succeeds on empty query
        : conformingShop(tool, input),
    );
    const results = await runSuiteAndCollect("codespar_shop");
    const malformedCase = results.find((r) => r.name.includes("malformed"));
    expect(malformedCase?.passed).toBe(false);
    expect(malformedCase?.error).toContain("malformed input");
  });

  it("drives a single-shot tool (discover) with no state machine", async () => {
    teardown = installFakeBackend((tool, input) => {
      if (tool.endsWith("__unregistered_probe")) {
        return {
          ...errResult(`Tool not registered: ${tool}`),
          tool,
        };
      }
      // Malformed discover: empty input.
      if (!input.use_case) return errResult("use_case: required");
      return okResult({
        use_case: input.use_case,
        search_strategy: "embedding",
        recommended: null,
        related: [],
        next_steps: [],
      });
    });
    const results = await runSuiteAndCollect("codespar_discover");
    const failures = results.filter((r) => !r.passed);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    // 1 single-shot case + 2 error legs.
    expect(results.length).toBe(3);
    expect(DISCOVER_CONTRACT.stateMachine).toBeUndefined();
  });
});
