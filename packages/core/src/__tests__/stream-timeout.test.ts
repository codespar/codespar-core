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

  it("sendStream times out when the initial fetch never returns headers/body", async () => {
    // Backend accepts the connection but never sends SSE headers/body.
    // Mirrors native fetch: hangs until the signal aborts, then rejects
    // with the signal reason.
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
    await expect(async () => {
      for await (const _ of session.sendStream("hi")) { /* never reached */ }
    }).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("paymentStatusStream times out when the initial fetch never returns headers/body", async () => {
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
    await expect(
      session.paymentStatusStream("tc1", { timeout: 50, onUpdate() {} }),
    ).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);

  it("paymentStatusStream stays alive while only heartbeat frames arrive", async () => {
    // Healthy long-pending flow: snapshot, then several SSE comment
    // heartbeats spaced below the idle window across more than one
    // window, then a terminal done. Heartbeats are complete frames —
    // they must keep the stream alive (parity with Python httpx, whose
    // read timeout is reset by any incoming bytes).
    const snapshot =
      'event: snapshot\ndata: {"tool_call_id":"tc1","payment_status":"pending","idempotency_key":null,"original_status":"success","hosted_url":null,"events":[]}\n\n';
    const done = 'event: done\ndata: {}\n\n';
    const enc = new TextEncoder();
    let stopped = false;
    let step = 0;
    // timeout 80ms; heartbeat every 40ms × 5 = 200ms (> 2 windows).
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        return new Promise<void>((r) => setTimeout(() => {
          if (stopped) return r();
          if (step === 0) ctrl.enqueue(enc.encode(snapshot));
          else if (step <= 5) ctrl.enqueue(enc.encode(":heartbeat\n\n"));
          else { ctrl.enqueue(enc.encode(done)); ctrl.close(); }
          step++;
          r();
        }, step === 0 ? 0 : 40));
      },
      cancel() { stopped = true; },
    });
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: stream } as unknown as Response);
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    const session = await cs.create("u");
    const result = await session.paymentStatusStream("tc1", { timeout: 80, onUpdate() {} });
    expect(result.payment_status).toBe("pending");
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
      // CallOptions is part of the public Session contract — no cast needed.
      for await (const _ of session.sendStream("hi", { signal: ac.signal })) { /* drain */ }
    })();
    queueMicrotask(() => ac.abort(reason));
    await expect(iterate).rejects.toBe(reason);
    expect(state.cancelled).toBe(true);
  }, 5000);

  it("paymentStatusStream: per-call timeout overrides the client default", async () => {
    // Stream emits one snapshot frame then idles forever.
    const snapshotFrame =
      'event: snapshot\ndata: {"tool_call_id":"tc1","payment_status":"pending","idempotency_key":null,"original_status":"success","hosted_url":null,"events":[]}\n\n';
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      // Any payment-status/stream URL: emit one frame then idle forever.
      return Promise.resolve({ ok: true, body: sse([snapshotFrame], 0) } as unknown as Response);
    }) as unknown as typeof fetch;

    // Client default is intentionally large; per-call override is 50 ms.
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10_000 });
    const session = await cs.create("u");
    await expect(
      session.paymentStatusStream("tc1", { timeout: 50, onUpdate() {} }),
    ).rejects.toBeInstanceOf(TimeoutError);
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

  it("does not time out when the consumer is slow between events", async () => {
    // Network delivers two frames promptly; the consumer spends longer
    // than the idle window processing the first one. The idle timer is
    // a TRANSPORT idle timeout — consumer processing time must not count
    // against it, otherwise healthy streams with heavy per-event work
    // false-timeout.
    const enc = new TextEncoder();
    const frames = [
      'event: assistant_text\ndata: {"content":"a","iteration":0}\n\n',
      'event: assistant_text\ndata: {"content":"b","iteration":1}\n\n',
    ];
    let fi = 0;
    // highWaterMark 0 → pull only fires on an actual read(), so the
    // post-sleep read genuinely waits on the network instead of
    // replaying a pre-buffered frame (which would mask the bug).
    const closing = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (fi >= frames.length) { ctrl.close(); return; }
        const c = frames[fi++]!;
        return new Promise((r) => setTimeout(() => { ctrl.enqueue(enc.encode(c)); r(); }, 10));
      },
    }, { highWaterMark: 0 });
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: closing } as unknown as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 80 });
    const session = await cs.create("u");
    let count = 0;
    for await (const ev of session.sendStream("hi")) {
      if (ev.type === "assistant_text") {
        count++;
        // Heavy per-event work, longer than the 80ms idle window.
        await new Promise((r) => setTimeout(r, 160));
      }
    }
    expect(count).toBe(2);
  }, 5000);

  it("times out on a byte trickle that never completes an SSE frame", async () => {
    // Server dribbles bytes faster than the idle window but never emits
    // a complete "\n\n" frame. The idle timer must reset per PARSED
    // event, not per raw read — otherwise the trickle resets it forever
    // and the hang is never detected.
    const enc = new TextEncoder();
    const partial = "event: assistant_text\n"; // no blank line → no frame
    let stopped = false;
    const trickle = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        return new Promise<void>((r) => setTimeout(() => {
          if (stopped) return r();
          ctrl.enqueue(enc.encode(partial));
          r();
        }, 20));
      },
      cancel() { stopped = true; },
    });
    globalThis.fetch = ((url: string) => {
      if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
      return Promise.resolve({ ok: true, body: trickle } as unknown as Response);
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 120 });
    const session = await cs.create("u");
    await expect(async () => {
      for await (const _ of session.sendStream("hi")) { /* never a full frame */ }
    }).rejects.toBeInstanceOf(TimeoutError);
  }, 5000);
});
