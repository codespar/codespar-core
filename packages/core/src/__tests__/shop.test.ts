/**
 * codespar_shop typed facade tests.
 *
 * Covers the discriminated `ShopArgs`/`ShopResult` union: it gives a
 * caller the action-correct result type without an untyped cast. A
 * `ready_for_payment` status result exposes typed `pix_copia_e_cola` +
 * `total_minor`; a `canceled` result exposes typed `error`. The facade also mirrors `charge()`: it dispatches
 * `execute("codespar_shop", args)` and throws `shop failed: <error>` on
 * `!success`.
 *
 * These drive the real `createSession` facade with a mocked `fetch`, so
 * the shipped client surface is exercised end-to-end (not a test
 * double); the wire dispatch (`tool` + `input`) is asserted on the
 * mocked `/execute` call.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  ShopArgs,
  ShopResult,
  ShopSearchResult,
  ShopCheckoutResult,
  ShopStatusResult,
  Session,
  ToolResult,
} from "@codespar/types";
import { createSession } from "../session.js";

interface ExecCall {
  toolName: string;
  params: Record<string, unknown>;
}

function envelope(over: Partial<ToolResult>): Partial<ToolResult> {
  return {
    success: true,
    data: null,
    error: null,
    duration: 1,
    server: "_codespar",
    tool: "codespar_shop",
    ...over,
  };
}

/**
 * Build a REAL session (`createSession`) whose `/execute` route returns
 * a caller-supplied envelope, so `shop()` exercises the shipped facade
 * end-to-end — not a test double. `fetch` is mocked: the create POST
 * returns a session, the execute POST returns the envelope.
 */
async function sessionReturning(over: Partial<ToolResult>): Promise<{
  session: Session;
  calls: ExecCall[];
}> {
  const calls: ExecCall[] = [];
  const env = envelope(over);
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (typeof url === "string" && url.endsWith("/execute")) {
      const body = JSON.parse(init?.body ?? "{}") as {
        tool: string;
        input: Record<string, unknown>;
      };
      calls.push({ toolName: body.tool, params: body.input });
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => env,
      };
    }
    // create session
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_shop",
        org_id: "org_test",
        user_id: "consumer_123",
        servers: ["cobasi"],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  const session = await createSession(
    "consumer_123",
    { servers: ["cobasi"] },
    { baseUrl: "https://api.example.com", apiKey: "csk_live_test", timeout: 60000 },
  );
  return { session, calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("session.shop facade", () => {
  it("dispatches execute('codespar_shop', args) and returns typed data", async () => {
    const data: ShopSearchResult = {
      rail: "vtex",
      products: [
        {
          product_id: "p1",
          sku_id: "sku1",
          title: "Ração",
          price_minor: 1990,
          currency: "BRL",
          available: true,
          variants: [{ sku_id: "sku1", available: true }],
        },
      ],
    };
    const { session, calls } = await sessionReturning({ success: true, data });

    const args: ShopArgs = {
      action: "search",
      query: "ração para gato",
      merchant: "cobasi",
      limit: 10,
    };
    const result = await session.shop(args);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("codespar_shop");
    expect(calls[0]!.params).toEqual(args);

    // discriminate on the search shape.
    if ("products" in result) {
      const search: ShopSearchResult = result;
      expect(search.rail).toBe("vtex");
      expect(search.products[0]!.variants[0]!.sku_id).toBe("sku1");
    } else {
      throw new Error("expected a search result");
    }
  });

  it("throws 'shop failed: <error>' when the envelope is unsuccessful", async () => {
    const { session } = await sessionReturning({
      success: false,
      error: "invalid_args",
    });
    await expect(
      session.shop({ action: "search", query: "x" }),
    ).rejects.toThrow("shop failed: invalid_args");
  });

  it("throws 'shop failed: unknown' when no error string is present", async () => {
    const { session } = await sessionReturning({ success: false });
    await expect(
      session.shop({ action: "checkout_status", checkout_session_id: "c1" }),
    ).rejects.toThrow("shop failed: unknown");
  });

  it("checkout returns an in_progress session result (async start)", async () => {
    const data: ShopCheckoutResult = {
      checkout_session_id: "cks_1",
      status: "in_progress",
      message: "started",
    };
    const { session } = await sessionReturning({ success: true, data });

    const result = await session.shop({
      action: "checkout",
      merchant: "cobasi",
      items: [{ variant_id: "sku1", quantity: 1 }],
      consumer_id: "consumer_123",
    });

    if ("products" in result) {
      throw new Error("expected a checkout result, got search");
    }
    // Narrowed off the search variant; status is reachable + typed.
    expect(result.status).toBe("in_progress");
    expect(result.checkout_session_id).toBe("cks_1");
  });

  it("a ready_for_payment status exposes typed pix_copia_e_cola + total_minor", async () => {
    const data: ShopStatusResult = {
      checkout_session_id: "cks_1",
      status: "ready_for_payment",
      rail: "vtex",
      total_minor: 1990,
      pix_copia_e_cola: "00020126...br.gov.bcb.pix",
    };
    const { session } = await sessionReturning({ success: true, data });

    const result = await session.shop({
      action: "checkout_status",
      checkout_session_id: "cks_1",
    });

    if ("products" in result) {
      throw new Error("expected a status result, got search");
    }
    // Narrowed off search; the payable Pix is typed, not unknown.
    if (result.status === "ready_for_payment") {
      const pix: string | undefined = result.pix_copia_e_cola;
      const total: number | undefined = result.total_minor;
      expect(pix).toContain("br.gov.bcb.pix");
      expect(total).toBe(1990);
    } else {
      throw new Error("expected ready_for_payment");
    }
  });

  it("a canceled status exposes the typed error field", async () => {
    const data: ShopStatusResult = {
      checkout_session_id: "cks_2",
      status: "canceled",
      error: "browser_worker_checkout_failed",
    };
    const { session } = await sessionReturning({ success: true, data });

    const result = await session.shop({
      action: "checkout_status",
      checkout_session_id: "cks_2",
    });

    if ("products" in result) {
      throw new Error("expected a status result, got search");
    }
    if (result.status === "canceled") {
      const err: string | undefined = result.error;
      expect(err).toBe("browser_worker_checkout_failed");
    } else {
      throw new Error("expected canceled");
    }
  });
});

/**
 * Compile-time discriminated-union assertions. These do not run
 * assertions at runtime — they fail the build if the union stops
 * narrowing correctly, which is the real guarantee the contract makes.
 */
describe("ShopResult type-level narrowing (compile-time)", () => {
  it("narrows each variant by its discriminant without an unknown cast", () => {
    const widen = (r: ShopResult): string => {
      if ("products" in r) {
        // ShopSearchResult
        return r.rail;
      }
      if (r.status === "in_progress" && !("rail" in r)) {
        // ShopCheckoutResult — status is the literal "in_progress"
        return r.checkout_session_id;
      }
      // ShopStatusResult
      return r.pix_copia_e_cola ?? r.error ?? r.status;
    };
    expect(typeof widen).toBe("function");
  });
});
