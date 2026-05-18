import { describe, it, expect, afterEach } from "vitest";
import { CodeSpar } from "../index.js";
import { TimeoutError } from "../errors.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sessionCreate(): Response {
  return { ok: true, status: 201, text: async () => "", json: async () => ({
    id: "ses_c", org_id: "o", user_id: "u", servers: [],
    status: "active", created_at: new Date().toISOString(), closed_at: null,
  }) } as unknown as Response;
}

describe("session.close timeout", () => {
  it("close() rejects with TimeoutError when the DELETE never responds", async () => {
    // Backend accepts the DELETE socket but never responds. Mirrors
    // native fetch: hangs until the signal aborts, then rejects.
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
    await expect(session.close()).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("close() honours a per-call timeout override", async () => {
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
    await expect(session.close({ timeout: 50 })).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);
});
