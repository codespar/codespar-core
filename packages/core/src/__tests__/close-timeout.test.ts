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

describe("session.close timeout", () => {
  it("close() is best-effort: a DELETE timeout is swallowed, not thrown", async () => {
    // Backend accepts the DELETE socket but never responds. close()
    // must stay bounded (the timeout budget still fires) AND best-effort
    // (it does not surface the timeout to the caller — parity with the
    // Python client and the managed-agents adapter).
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener(
          "abort",
          () => rej((init.signal as AbortSignal).reason),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 50 });
    const session = await cs.create("u");
    const start = Date.now();
    await expect(session.close()).resolves.toBeUndefined();
    // Bounded: it returned because the 50ms budget fired, not because
    // it hung until the 5s test timeout.
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);

  it("close() still validates the timeout (invalid value is NOT swallowed)", async () => {
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, status: 204, text: async () => "" } as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x" });
    const session = await cs.create("u");
    await expect(session.close({ timeout: 0 })).rejects.toThrow(/timeout/i);
  }, 5000);

  it("close() stays best-effort with a per-call timeout override", async () => {
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return new Promise((_res, rej) => {
        init?.signal?.addEventListener(
          "abort",
          () => rej((init.signal as AbortSignal).reason),
          { once: true },
        );
      });
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    const session = await cs.create("u");
    const start = Date.now();
    await expect(session.close({ timeout: 50 })).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);
});
