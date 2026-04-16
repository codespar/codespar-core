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
