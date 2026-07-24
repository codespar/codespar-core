import { describe, it, expect, afterEach } from "vitest";
import { CodeSpar } from "../index.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sessionCreate(): Response {
  return { ok: true, status: 201, text: async () => "", json: async () => ({
    id: "ses_c", org_id: "o", user_id: "u", servers: [],
    status: "active", created_at: new Date().toISOString(), closed_at: null,
  }) } as unknown as Response;
}

describe("session.connections timeout", () => {
  it("connections() validates the timeout (invalid value is NOT swallowed into the cache fallback)", async () => {
    let connectionsFetches = 0;
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      connectionsFetches++;
      return Promise.resolve({ ok: true, status: 200, text: async () => "", json: async () => ({ servers: [], tools: [] }) } as unknown as Response);
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" });
    const session = await cs.create("u");
    await expect(session.connections({ timeout: 0 })).rejects.toThrow(/timeout/i);
    await expect(session.connections({ timeout: Number.NaN })).rejects.toThrow(/timeout/i);
    // Fail-fast: the request never left the client.
    expect(connectionsFetches).toBe(0);
  }, 5000);

  it("connections() stays best-effort: a transport failure resolves to the cached list", async () => {
    let fail = false;
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      if (fail) return Promise.reject(new TypeError("network down"));
      return Promise.resolve({ ok: true, status: 200, text: async () => "", json: async () => ({
        servers: [{ id: "srv_1", name: "zoop", category: "payments", country: "BR", auth_type: "none", connected: true }],
        tools: [],
      }) } as unknown as Response);
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" });
    const session = await cs.create("u");

    // Warm the cache, then fail the transport — the cached list comes back.
    const first = await session.connections();
    expect(first).toHaveLength(1);
    fail = true;
    await expect(session.connections()).resolves.toEqual(first);
  }, 5000);

  it("connections() with an empty cache resolves to [] on transport failure", async () => {
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.reject(new TypeError("network down"));
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" });
    const session = await cs.create("u");
    await expect(session.connections()).resolves.toEqual([]);
  }, 5000);
});
