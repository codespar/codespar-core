import { describe, it, expect, afterEach, vi } from "vitest";
import { CodeSpar } from "../index.js";
import { TimeoutError } from "../errors.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

function sse(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= chunks.length) return new Promise(() => {}); // then idle forever
      const c = chunks[i++]!;
      return new Promise((r) => setTimeout(() => { ctrl.enqueue(enc.encode(c)); r(); }, gapMs));
    },
  });
}

function sessionCreate(): Response {
  return { ok: true, status: 201, text: async () => "", json: async () => ({
    id: "ses_s", org_id: "o", user_id: "u", servers: [],
    status: "active", created_at: new Date().toISOString(), closed_at: null,
  }) } as unknown as Response;
}

function trackedSse(chunks: string[], gapMs: number) {
  const enc = new TextEncoder();
  let i = 0;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= chunks.length) return new Promise(() => {});
      const c = chunks[i++]!;
      return new Promise((r) => setTimeout(() => { ctrl.enqueue(enc.encode(c)); r(); }, gapMs));
    },
    cancel() { state.cancelled = true; },
  });
  return { stream, state };
}

describe("stream idle timeout", () => {
  it("sendStream throws TimeoutError when the stream goes idle past the window", async () => {
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body:
        sse(['event: assistant_text\ndata: {"content":"hi","iteration":1}\n\n'], 0) } as unknown as Response);
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 50 });
    const session = await cs.create("u");
    await expect(async () => {
      for await (const _ of session.sendStream("hi")) { /* drain; stream idles after 1 event */ }
    }).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("cancels the response body when the idle timeout fires", async () => {
    const { stream, state } = trackedSse(['event: assistant_text\ndata: {"content":"hi","iteration":1}\n\n'], 0);
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: stream } as unknown as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 50 });
    const session = await cs.create("u");
    await expect(async () => {
      for await (const _ of session.sendStream("hi")) { /* drain */ }
    }).rejects.toBeInstanceOf(TimeoutError);
    expect(state.cancelled).toBe(true);
  }, 5000);

  it("propagates the caller's abort reason (not TimeoutError) and cancels the body", async () => {
    const { stream, state } = trackedSse([], 0); // never emits
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: stream } as unknown as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    const session = await cs.create("u");
    const ac = new AbortController();
    const reason = new DOMException("user cancelled", "AbortError");
    const iterate = (async () => {
      // Cast through unknown: Session type has 1-arg sendStream; impl accepts CallOptions.
      const s = session as unknown as { sendStream(m: string, o: { signal: AbortSignal }): AsyncIterable<unknown> };
      for await (const _ of s.sendStream("hi", { signal: ac.signal })) { /* drain */ }
    })();
    queueMicrotask(() => ac.abort(reason));
    await expect(iterate).rejects.toBe(reason);
    expect(state.cancelled).toBe(true);
  }, 5000);

  it("drains a steady multi-frame stream without timing out", async () => {
    const frames = Array.from({ length: 12 }, (_, n) =>
      `event: assistant_text\ndata: {"content":"c${n}","iteration":${n}}\n\n`);
    // Use a stream that closes (ctrl.close()) after all frames so the parser
    // sees done=true rather than idling forever post-last-frame.
    const enc = new TextEncoder();
    let fi = 0;
    const closingStream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (fi >= frames.length) { ctrl.close(); return; }
        const c = frames[fi++]!;
        return new Promise((r) => setTimeout(() => { ctrl.enqueue(enc.encode(c)); r(); }, 5));
      },
    });
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: closingStream } as unknown as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 500 });
    const session = await cs.create("u");
    let count = 0;
    for await (const ev of session.sendStream("hi")) {
      if (ev.type === "assistant_text") count++;
    }
    expect(count).toBe(12);
  }, 5000);
});
