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
});
