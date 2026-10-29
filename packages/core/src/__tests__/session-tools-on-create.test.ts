import { describe, it, expect, afterEach } from "vitest";
import { CodeSpar } from "../index.js";

/**
 * `session.tools()` reads the tools the creation response carries, and only
 * when it carries none asks GET /v1/sessions/:id/connections, as before.
 */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const TOOL = { name: "codespar_wallet", description: "Read the account", input_schema: { type: "object" }, server_id: "codespar" };

function sessionCreate(extra: Record<string, unknown> = {}): Response {
  return { ok: true, status: 201, text: async () => "", json: async () => ({
    id: "ses_t", org_id: "o", user_id: "u", servers: [],
    status: "active", created_at: new Date().toISOString(), closed_at: null,
    ...extra,
  }) } as unknown as Response;
}

function harness(created: Record<string, unknown>) {
  const calls = { connections: 0 };
  globalThis.fetch = ((url: string) => {
    if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate(created));
    calls.connections++;
    return Promise.resolve({ ok: true, status: 200, text: async () => "", json: async () => ({
      servers: [], tools: [{ ...TOOL, name: "from_connections" }],
    }) } as unknown as Response);
  }) as unknown as typeof fetch;
  return calls;
}

describe("session.tools() on creation", () => {
  it("uses the tools the creation response carries, without asking the connections route", async () => {
    const calls = harness({ tools: [TOOL] });
    const session = await new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" }).create("u");
    await expect(session.tools()).resolves.toEqual([TOOL]);
    expect(calls.connections).toBe(0);
  }, 5000);

  it("falls back to GET /v1/sessions/:id/connections when the creation response has no tools", async () => {
    const calls = harness({});
    const session = await new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" }).create("u");
    const tools = await session.tools();
    expect(tools.map((t) => t.name)).toEqual(["from_connections"]);
    expect(calls.connections).toBe(1);
  }, 5000);

  it("an empty list on creation is an answer (no round trip); a non-array is ignored", async () => {
    const empty = harness({ tools: [] });
    const s1 = await new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" }).create("u");
    await expect(s1.tools()).resolves.toEqual([]);
    expect(empty.connections).toBe(0);

    const junk = harness({ tools: "nope" });
    const s2 = await new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" }).create("u");
    expect((await s2.tools()).map((t) => t.name)).toEqual(["from_connections"]);
    expect(junk.connections).toBe(1);
  }, 5000);
});
