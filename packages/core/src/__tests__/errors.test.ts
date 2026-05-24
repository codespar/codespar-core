/**
 * Tests for CodesparApiError + the throwFromResponse helper that
 * collapses all transport-failure throw sites in session.ts.
 *
 * Asserts:
 *   - Every transport throw site surfaces a CodesparApiError (not
 *     a plain Error) carrying status + code + body.
 *   - Network errors wrap fetch rejections into CodesparApiError
 *     with status: 0 and preserve the underlying cause.
 *   - The session.execute non-ok branch is untouched — it still
 *     returns ToolResult.success === false rather than throwing.
 *   - instanceof CodesparApiError works across realms (prototype
 *     chain is restored via Object.setPrototypeOf).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CodesparApiError } from "../errors.js";
import { CodeSpar } from "../index.js";

describe("CodesparApiError", () => {
  it("constructs with status + message", () => {
    const err = new CodesparApiError("boom", { status: 500 });
    expect(err.status).toBe(500);
    expect(err.message).toBe("boom");
    expect(err.code).toBeUndefined();
    expect(err.body).toBeUndefined();
  });

  it("carries the structured code + body + cause", () => {
    const cause = new Error("underlying");
    const err = new CodesparApiError("boom", {
      status: 403,
      code: "mocks_not_permitted",
      body: { error: "mocks_not_permitted", message: "test mode key required" },
      cause,
    });
    expect(err.status).toBe(403);
    expect(err.code).toBe("mocks_not_permitted");
    expect(err.body).toEqual({
      error: "mocks_not_permitted",
      message: "test mode key required",
    });
    expect(err.cause).toBe(cause);
  });

  it("instanceof CodesparApiError works after prototype-chain repair", () => {
    const err = new CodesparApiError("x", { status: 1 });
    expect(err instanceof CodesparApiError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(err.name).toBe("CodesparApiError");
  });
});

describe("session transport-failure call sites throw CodesparApiError", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("createSession throws CodesparApiError on 4xx with structured body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: "mocks_not_permitted",
          message: "csk_test_* key required",
        }),
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });

    try {
      await cs.create("user_42");
      expect.fail("expected createSession to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodesparApiError);
      const apiErr = err as CodesparApiError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.code).toBe("mocks_not_permitted");
    }
  });

  it("createSession wraps fetch rejection as CodesparApiError status 0", async () => {
    const underlying = new TypeError("Network failure");
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(underlying) as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });

    try {
      await cs.create("user_42");
      expect.fail("expected createSession to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodesparApiError);
      const apiErr = err as CodesparApiError;
      expect(apiErr.status).toBe(0);
      expect(apiErr.cause).toBe(underlying);
    }
  });

  it("send throws CodesparApiError on 5xx", async () => {
    const sessionCreate = {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_err",
        org_id: "o",
        user_id: "u",
        servers: [],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    };
    const sendFail = {
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ code: "upstream_unavailable" }),
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(sessionCreate)
      .mockResolvedValueOnce(sendFail) as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    const session = await cs.create("u");
    await expect(session.send("hi")).rejects.toBeInstanceOf(CodesparApiError);
  });

  it("session.execute does NOT throw on non-ok — returns ToolResult.success=false", async () => {
    const sessionCreate = {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_ok",
        org_id: "o",
        user_id: "u",
        servers: [],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    };
    const execFail = {
      ok: false,
      status: 422,
      text: async () => "validation failed",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(sessionCreate)
      .mockResolvedValueOnce(execFail) as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    const session = await cs.create("u");
    const result = await session.execute("asaas/create_payment", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("422");
  });
});
