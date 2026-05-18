import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "../internal/fetch.js";
import { TimeoutError } from "../errors.js";

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
    const out = await fetchWithTimeout("https://x/y", { method: "GET" }, { timeout: 1000 });
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
      fetchWithTimeout("https://x/y", {}, { timeout: 5 }),
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
    const p = fetchWithTimeout("https://x/y", {}, { timeout: 9999, signal: ac.signal });
    const reason = new DOMException("aborted", "AbortError");
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
  });
});
