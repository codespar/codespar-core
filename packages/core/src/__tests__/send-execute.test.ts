import { describe, it, expect, vi, afterEach } from "vitest";
import { CodeSpar } from "../index.js";

const SESSION_CREATE = {
  ok: true,
  status: 201,
  text: async () => "",
  json: async () => ({
    id: "ses_se1",
    org_id: "org_test",
    user_id: "u1",
    servers: ["zoop"],
    status: "active",
    created_at: "2026-04-21T12:00:00Z",
    closed_at: null,
  }),
};
async function makeSession(resp: unknown) {
  const m = vi.fn().mockResolvedValueOnce(SESSION_CREATE).mockResolvedValueOnce(resp);
  globalThis.fetch = m as unknown as typeof fetch;
  const cs = new CodeSpar({ apiKey: "csk_test_x", baseUrl: "https://api.example.com" });
  const session = await cs.create("u1", { servers: ["zoop"] });
  return { session, m };
}
type Init = { method: string; headers: Record<string, string>; body: string };

describe("session.execute", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /execute with auth header and {tool,input} body, returns ToolResult", async () => {
    const { session, m } = await makeSession({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        success: true,
        data: { pix_id: "pix_1" },
        error: null,
        duration: 120,
        server: "asaas",
        tool: "asaas/create_payment",
      }),
    });
    const r = await session.execute("asaas/create_payment", { value: 500 });

    const [url, init] = m.mock.calls[1] as [string, Init];
    expect(url).toBe("https://api.example.com/v1/sessions/ses_se1/execute");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer csk_test_x");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ tool: "asaas/create_payment", input: { value: 500 } });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ pix_id: "pix_1" });
    expect(r.server).toBe("asaas");
  });

  it("soft-fails with status-prefixed error on non-ok", async () => {
    const { session } = await makeSession({
      ok: false,
      status: 502,
      text: async () => "upstream down",
      json: async () => ({}),
    });
    const r = await session.execute("asaas/create_payment", {});
    expect(r.success).toBe(false);
    expect(r.data).toBeNull();
    expect(r.error).toBe("502: upstream down");
    expect(r.tool).toBe("asaas/create_payment");
  });
});

describe("session.send", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /send with JSON Accept header and {message} body, returns SendResult", async () => {
    const { session, m } = await makeSession({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        message: "Charged R$500.",
        tool_calls: [
          {
            id: "tc_1",
            tool_name: "codespar_pay",
            server_id: "asaas",
            status: "success",
            duration_ms: 412,
            input: { amount: 500 },
            output: { pix_id: "pix_1" },
            error_code: null,
          },
        ],
        iterations: 1,
      }),
    });
    const r = await session.send("charge R$500 via Pix");

    const [url, init] = m.mock.calls[1] as [string, Init];
    expect(url).toBe("https://api.example.com/v1/sessions/ses_se1/send");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer csk_test_x");
    expect(init.headers.Accept).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ message: "charge R$500 via Pix" });
    expect(r.message).toBe("Charged R$500.");
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls[0]!.tool_name).toBe("codespar_pay");
    expect(r.iterations).toBe(1);
  });

  it("returns SendResult with tool_calls on success", async () => {
    const { session } = await makeSession({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        message: "Charged R$500.",
        tool_calls: [
          {
            id: "tc_1",
            tool_name: "codespar_pay",
            server_id: "asaas",
            status: "success",
            duration_ms: 412,
            input: { amount: 500 },
            output: { pix_id: "pix_1" },
            error_code: null,
          },
        ],
        iterations: 1,
      }),
    });
    const r = await session.send("charge R$500 via Pix");
    expect(r.message).toBe("Charged R$500.");
    expect(r.tool_calls).toHaveLength(1);
    expect(r.tool_calls[0]!.tool_name).toBe("codespar_pay");
    expect(r.iterations).toBe(1);
  });

  it("throws 'send failed: <status> <body>' on non-ok", async () => {
    const { session } = await makeSession({
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    });
    await expect(session.send("hi")).rejects.toThrow("send failed: 500 boom");
  });
});
