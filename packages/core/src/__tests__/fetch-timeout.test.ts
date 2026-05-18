import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "../internal/fetch.js";
import { TimeoutError } from "../errors.js";
import { CodeSpar } from "../index.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWithTimeout", () => {
  it("passes a signal to fetch and returns the response on success", async () => {
    const res = { ok: true, status: 200 } as Response;
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return res;
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await fetchWithTimeout(
      "https://x/y",
      { method: "GET" },
      { timeout: 1000 },
      async (r) => r,
    );
    expect(out).toBe(res);
  });

  it("throws TimeoutError when the timeout fires before fetch resolves", async () => {
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    await expect(
      fetchWithTimeout("https://x/y", {}, { timeout: 5 }, async (r) => r),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("re-throws the caller's AbortError when the caller signal aborts", async () => {
    const ac = new AbortController();
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    const p = fetchWithTimeout("https://x/y", {}, { timeout: 9999, signal: ac.signal }, async (r) => r);
    const reason = new DOMException("aborted", "AbortError");
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
  });

  it("rethrows an unrelated fetch error unchanged when no signal aborted", async () => {
    const netErr = new TypeError("Failed to fetch");
    globalThis.fetch = (() => Promise.reject(netErr)) as unknown as typeof fetch;
    await expect(
      fetchWithTimeout("https://x/y", {}, { timeout: 9999 }, async (r) => r),
    ).rejects.toBe(netErr);
  });

  it("execute() rejects with TimeoutError when the backend hangs", async () => {
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (String(url).endsWith("/v1/sessions")) {
        return Promise.resolve({
          ok: true, status: 201, text: async () => "",
          json: async () => ({
            id: "ses_h", org_id: "o", user_id: "u", servers: [],
            status: "active", created_at: new Date().toISOString(), closed_at: null,
          }),
        } as Response);
      }
      // /execute hangs until aborted
      return new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
      );
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10 });
    const session = await cs.create("u");
    await expect(session.execute("t", {})).rejects.toBeInstanceOf(TimeoutError);
  });

  it("execute() rejects with TimeoutError when headers arrive but the body stalls", async () => {
    globalThis.fetch = ((url: string, init: RequestInit) => {
      if (String(url).endsWith("/v1/sessions")) {
        return Promise.resolve({
          ok: true, status: 201, text: async () => "",
          json: async () => ({
            id: "ses_b", org_id: "o", user_id: "u", servers: [],
            status: "active", created_at: new Date().toISOString(), closed_at: null,
          }),
        } as Response);
      }
      // Headers arrive immediately, but reading the body never resolves
      // until the request signal aborts (mirrors native fetch: the body
      // stream is tied to the same AbortSignal as the fetch).
      const sig = init.signal!;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => new Promise((_r, rej) =>
          sig.addEventListener("abort", () => rej(sig.reason), { once: true })),
        json: () => new Promise((_r, rej) =>
          sig.addEventListener("abort", () => rej(sig.reason), { once: true })),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10 });
    const session = await cs.create("u");
    await expect(session.execute("t", {})).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("create() honours a per-call timeout override on POST /v1/sessions", async () => {
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      )) as unknown as typeof fetch;
    // Client default large; per-call override is what must fire.
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    await expect(cs.create("u", {}, { timeout: 20 })).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("create() propagates the caller's abort reason on POST /v1/sessions", async () => {
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }),
      )) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    const ac = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    const p = cs.create("u", {}, { signal: ac.signal });
    queueMicrotask(() => ac.abort(reason));
    await expect(p).rejects.toBe(reason);
  }, 5000);
});
