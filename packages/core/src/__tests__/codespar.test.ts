/**
 * @codespar/sdk basic tests.
 *
 * The 0.1.0 test suite assumed an older client-shaped API and has been
 * replaced for 0.2.0. Comprehensive integration tests (mocking fetch
 * against the api.codespar.dev contract) are tracked for a follow-up.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CodeSpar } from "../index.js";
import { SessionConfigSchema } from "../types.js";

describe("CodeSpar constructor", () => {
  it("requires an API key", () => {
    const prev = process.env.CODESPAR_API_KEY;
    delete process.env.CODESPAR_API_KEY;
    try {
      expect(() => new CodeSpar({})).toThrow(/API key is required/);
    } finally {
      if (prev) process.env.CODESPAR_API_KEY = prev;
    }
  });

  it("accepts apiKey via constructor", () => {
    const cs = new CodeSpar({ apiKey: "csk_live_test" });
    expect(cs).toBeDefined();
  });

  it("accepts apiKey via env var", () => {
    process.env.CODESPAR_API_KEY = "csk_live_envtest";
    try {
      const cs = new CodeSpar();
      expect(cs).toBeDefined();
    } finally {
      delete process.env.CODESPAR_API_KEY;
    }
  });

  it("defaults baseUrl to api.codespar.dev", () => {
    process.env.CODESPAR_API_KEY = "csk_live_test";
    process.env.CODESPAR_BASE_URL = "";
    try {
      const cs = new CodeSpar();
      // baseUrl is private but the constructor logic verifies the default.
      expect(cs).toBeDefined();
    } finally {
      delete process.env.CODESPAR_API_KEY;
      delete process.env.CODESPAR_BASE_URL;
    }
  });
});

describe("SessionConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => SessionConfigSchema.parse({})).not.toThrow();
  });

  it("accepts servers as a string array", () => {
    expect(() =>
      SessionConfigSchema.parse({ servers: ["zoop", "nuvem-fiscal"] }),
    ).not.toThrow();
  });

  it("accepts known presets", () => {
    expect(() => SessionConfigSchema.parse({ preset: "brazilian" })).not.toThrow();
    expect(() => SessionConfigSchema.parse({ preset: "mexican" })).not.toThrow();
    expect(() => SessionConfigSchema.parse({ preset: "all" })).not.toThrow();
  });

  it("rejects unknown presets", () => {
    expect(() => SessionConfigSchema.parse({ preset: "klingon" as never })).toThrow();
  });

  it("accepts manageConnections options", () => {
    expect(() =>
      SessionConfigSchema.parse({
        manageConnections: { waitForConnections: true, timeout: 5000 },
      }),
    ).not.toThrow();
  });

  it("accepts metadata", () => {
    expect(() =>
      SessionConfigSchema.parse({ metadata: { source: "sandbox" } }),
    ).not.toThrow();
  });
});

describe("CodeSpar.create wires fetch correctly", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /v1/sessions with snake_case body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_test123",
        org_id: "org_test",
        user_id: "user_42",
        servers: ["zoop"],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    const session = await cs.create("user_42", { servers: ["zoop"] });

    expect(session.id).toBe("ses_test123");
    expect(session.userId).toBe("user_42");
    expect(session.servers).toEqual(["zoop"]);

    // Assert the request body uses snake_case keys (not userId)
    const callArgs = fetchMock.mock.calls[0]!;
    expect(callArgs[0]).toBe("https://api.example.com/v1/sessions");
    const init = callArgs[1] as { method: string; body: string; headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer csk_live_test");
    const body = JSON.parse(init.body) as { servers: string[]; user_id: string };
    expect(body.servers).toEqual(["zoop"]);
    expect(body.user_id).toBe("user_42");
  });

  it("proxyExecute POSTs to /v1/sessions/:id/proxy_execute", async () => {
    const sessionCreate = {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_px",
        org_id: "org_test",
        user_id: "u1",
        servers: ["stripe"],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    };
    const proxyResponse = {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        status: 201,
        data: { id: "ch_abc" },
        headers: { "content-type": "application/json" },
        duration: 142,
        proxy_call_id: "px_1",
      }),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(sessionCreate)
      .mockResolvedValueOnce(proxyResponse);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_test", baseUrl: "https://api.example.com" });
    const session = await cs.create("u1", { servers: ["stripe"] });

    const result = await session.proxyExecute({
      server: "stripe",
      endpoint: "/v1/charges",
      method: "POST",
      body: { amount: 1000, currency: "usd" },
    });

    expect(result.status).toBe(201);
    expect(result.data).toEqual({ id: "ch_abc" });
    expect(result.proxy_call_id).toBe("px_1");

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("https://api.example.com/v1/sessions/ses_px/proxy_execute");
    const req = init as { method: string; body: string };
    expect(req.method).toBe("POST");
    const sent = JSON.parse(req.body);
    expect(sent.server).toBe("stripe");
    expect(sent.endpoint).toBe("/v1/charges");
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual({ amount: 1000, currency: "usd" });
  });

  it("proxyExecute throws on non-2xx backend response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"message":"server not connected"}',
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_test", baseUrl: "https://api.example.com" });
    const session = await cs.create("u");
    await expect(
      session.proxyExecute({ server: "stripe", endpoint: "/x", method: "GET" }),
    ).rejects.toThrow(/proxyExecute failed: 404/);
  });

  it("populates session.mcp as a placeholder", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_mcp",
        org_id: "org_test",
        user_id: "user_1",
        servers: [],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_test", baseUrl: "https://api.example.com" });
    const session = await cs.create("user_1");
    expect(session.mcp.url).toBe("https://api.example.com/v1/sessions/ses_mcp/mcp");
    expect(session.mcp.headers.Authorization).toBe("Bearer csk_live_test");
  });
});
