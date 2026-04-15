import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CodeSpar, SessionConfigSchema } from "../index.js";
import { createSession } from "../session.js";
import type { Session, Tool, ToolResult } from "../types.js";

/* ── Helpers ── */

function mockTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "ZOOP_CREATE_CHARGE",
    slug: "zoop_create_charge",
    description: "Create a Pix charge",
    server: "zoop",
    inputSchema: { type: "object", properties: { amount: { type: "number" } } },
    ...overrides,
  };
}

function successResult(tool = "ZOOP_CREATE_CHARGE"): ToolResult {
  return { success: true, data: { id: "ch_1" }, duration: 42, server: "zoop", tool };
}

function failResult(tool = "ZOOP_CREATE_CHARGE"): ToolResult {
  return { success: false, data: null, error: "500: Internal Server Error", duration: 10, server: "zoop", tool };
}

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

/* ── CodeSpar constructor ── */

describe("CodeSpar", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws without API key", () => {
    delete process.env.CODESPAR_API_KEY;
    expect(() => new CodeSpar()).toThrow("CodeSpar API key is required");
  });

  it("accepts apiKey via config", () => {
    const cs = new CodeSpar({ apiKey: "ak_test" });
    expect(cs).toBeInstanceOf(CodeSpar);
  });

  it("reads API key from env when not in config", () => {
    process.env.CODESPAR_API_KEY = "ak_env";
    const cs = new CodeSpar();
    expect(cs).toBeInstanceOf(CodeSpar);
  });
});

/* ── SessionConfigSchema ── */

describe("SessionConfigSchema", () => {
  it("validates a valid config", () => {
    const result = SessionConfigSchema.safeParse({
      servers: ["zoop", "nfe"],
      preset: "brazilian",
      manageConnections: { waitForConnections: true, timeout: 5000 },
      metadata: { org: "acme" },
    });
    expect(result.success).toBe(true);
  });

  it("validates empty config", () => {
    expect(SessionConfigSchema.safeParse({}).success).toBe(true);
  });

  it("rejects invalid preset", () => {
    const result = SessionConfigSchema.safeParse({ preset: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects non-string servers", () => {
    const result = SessionConfigSchema.safeParse({ servers: [123] });
    expect(result.success).toBe(false);
  });
});

/* ── createSession ── */

describe("createSession", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = mockFetchResponse({
      id: "sess_1",
      servers: [{ id: "zoop", name: "Zoop", pkg: "@codespar/zoop", connected: true, auth: "oauth2", toolCount: 3 }],
      mcp: { url: "https://mcp.codespar.dev/sess_1", headers: { Authorization: "Bearer tok" } },
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes POST to /v1/sessions", async () => {
    await createSession("user_1", { preset: "brazilian" }, {
      baseUrl: "https://api.codespar.dev",
      apiKey: "ak_test",
      managed: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.codespar.dev/v1/sessions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on non-ok response", async () => {
    fetchMock = mockFetchResponse("Unauthorized", false, 401);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSession("user_1", {}, { baseUrl: "https://api.codespar.dev", apiKey: "bad", managed: true })
    ).rejects.toThrow("Failed to create session");
  });

  it("returns session with correct id and userId", async () => {
    const session = await createSession("user_1", {}, {
      baseUrl: "https://api.codespar.dev",
      apiKey: "ak_test",
      managed: true,
    });

    expect(session.id).toBe("sess_1");
    expect(session.userId).toBe("user_1");
  });
});

/* ── session.findTools ── */

describe("session.findTools", () => {
  let session: Session;

  beforeEach(async () => {
    const sessionResponse = {
      id: "sess_1",
      servers: [],
      mcp: { url: "https://mcp.codespar.dev/sess_1", headers: {} },
    };
    const connectionsResponse = {
      servers: [],
      tools: [
        mockTool({ name: "ZOOP_CREATE_CHARGE", slug: "zoop_create_charge", description: "Create a Pix charge", server: "zoop" }),
        mockTool({ name: "NFE_ISSUE", slug: "nfe_issue", description: "Issue an NF-e invoice", server: "nfe" }),
        mockTool({ name: "ZOOP_REFUND", slug: "zoop_refund", description: "Refund a charge", server: "zoop" }),
      ],
    };

    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sessionResponse) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(connectionsResponse) });
    }));

    session = await createSession("u1", {}, { baseUrl: "https://api.test", apiKey: "ak", managed: true });
    await session.connections();
  });

  afterEach(() => vi.restoreAllMocks());

  it("filters by tool name", () => {
    expect(session.findTools("refund")).toHaveLength(1);
    expect(session.findTools("refund")[0].slug).toBe("zoop_refund");
  });

  it("filters by server name", () => {
    const zoopTools = session.findTools("zoop");
    expect(zoopTools).toHaveLength(2);
  });

  it("filters by description", () => {
    expect(session.findTools("invoice")).toHaveLength(1);
  });

  it("returns empty when no tools cached", async () => {
    // Create fresh session without calling connections()
    vi.stubGlobal("fetch", mockFetchResponse({
      id: "sess_2", servers: [], mcp: { url: "u", headers: {} },
    }));
    const fresh = await createSession("u2", {}, { baseUrl: "https://api.test", apiKey: "ak", managed: true });
    expect(fresh.findTools("anything")).toEqual([]);
  });
});

/* ── session.loop ── */

describe("session.loop", () => {
  let session: Session;
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sessionData = { id: "sess_1", servers: [], mcp: { url: "u", headers: {} } };

    fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(sessionData) }); // createSession

    vi.stubGlobal("fetch", fetchImpl);
    session = await createSession("u1", {}, { baseUrl: "https://api.test", apiKey: "ak", managed: true });
  });

  afterEach(() => vi.restoreAllMocks());

  it("executes steps in order", async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_a")) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_b")) });

    const result = await session.loop({
      steps: [
        { server: "a", tool: "step_a", params: { x: 1 } },
        { server: "b", tool: "step_b", params: { y: 2 } },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(2);
    expect(result.totalSteps).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it("aborts on error by default", async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("err") })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_b")) });

    const result = await session.loop({
      steps: [
        { server: "a", tool: "step_a", params: {} },
        { server: "b", tool: "step_b", params: {} },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.completedSteps).toBe(0);
    // Second step should not have been called
    expect(fetchImpl).toHaveBeenCalledTimes(2); // 1 createSession + 1 failed execute
  });

  it("continues on error when abortOnError is false", async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("err") })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_b")) });

    const result = await session.loop({
      steps: [
        { server: "a", tool: "step_a", params: {} },
        { server: "b", tool: "step_b", params: {} },
      ],
      abortOnError: false,
    });

    expect(result.completedSteps).toBe(1);
    expect(result.results).toHaveLength(2);
  });

  it("retries failed steps", async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("err") }) // attempt 0
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_a")) }); // attempt 1

    const result = await session.loop({
      steps: [{ server: "a", tool: "step_a", params: {} }],
      retryPolicy: { maxRetries: 1, baseDelay: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(1);
  });

  it("skips steps when 'when' returns false", async () => {
    fetchImpl
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("step_a")) });

    const result = await session.loop({
      steps: [
        { server: "a", tool: "step_a", params: {} },
        { server: "b", tool: "step_b", params: {}, when: () => false },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it("calls onStepComplete callback", async () => {
    fetchImpl.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(successResult("s")) });

    const onComplete = vi.fn();
    await session.loop({
      steps: [{ server: "a", tool: "s", params: {} }],
      onStepComplete: onComplete,
    });

    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "s" }),
      expect.objectContaining({ success: true }),
      0
    );
  });

  it("calls onStepError callback on failure", async () => {
    fetchImpl.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("boom") });

    const onError = vi.fn();
    await session.loop({
      steps: [{ server: "a", tool: "s", params: {} }],
      onStepError: onError,
    });

    expect(onError).toHaveBeenCalledOnce();
  });
});
