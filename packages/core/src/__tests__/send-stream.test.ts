import { describe, it, expect, vi, afterEach } from "vitest";
import { CodeSpar } from "../index.js";
import type { StreamEvent } from "@codespar/types";

function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
}
// Emits each provided byte slice as a separate `read()`, so a frame split
// across slices exercises the parser's cross-chunk buffer-split path.
function chunkedStream(...slices: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of slices) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
const SESSION_CREATE = {
  ok: true,
  status: 201,
  text: async () => "",
  json: async () => ({
    id: "ses_abc123",
    org_id: "org_test",
    user_id: "user_123",
    servers: ["zoop", "nuvem-fiscal"],
    status: "active",
    created_at: "2026-04-21T12:00:00Z",
    closed_at: null,
  }),
};
async function streamSession(streamResp: unknown) {
  const m = vi.fn().mockResolvedValueOnce(SESSION_CREATE).mockResolvedValueOnce(streamResp);
  globalThis.fetch = m as unknown as typeof fetch;
  const cs = new CodeSpar({ apiKey: "csk_test_x", baseUrl: "https://api.example.com" });
  const session = await cs.create("user_123", { preset: "brazilian" });
  return { session, m };
}
function okStream(body: ReadableStream<Uint8Array> | null) {
  return { ok: true, status: 200, text: async () => "", body };
}
async function collect(session: { sendStream(m: string): AsyncIterable<StreamEvent> }) {
  const events: StreamEvent[] = [];
  for await (const e of session.sendStream("go")) events.push(e);
  return events;
}

describe("session.sendStream — SSE parsing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /send with SSE Accept header and serialized message body", async () => {
    const { session, m } = await streamSession(
      okStream(sseStream(frame("assistant_text", { content: "ok", iteration: 1 }))),
    );
    for await (const _ of session.sendStream("hello")) void _;

    const [url, init] = m.mock.calls[1] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://api.example.com/v1/sessions/ses_abc123/send");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer csk_test_x");
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(JSON.parse(init.body)).toEqual({ message: "hello" });
  });

  // assistant_text and tool_use are flat (no envelope) in BOTH SDKs, so
  // these are real parity assertions, not drift tripwires.
  it("yields typed events for assistant_text and tool_use", async () => {
    const { session } = await streamSession(
      okStream(
        sseStream(
          frame("assistant_text", { content: "Processing…", iteration: 1 }),
          frame("tool_use", { id: "tu_1", name: "codespar_pay", input: { amount: 500 } }),
        ),
      ),
    );
    const events = await collect(session);
    expect(events).toEqual([
      { type: "assistant_text", content: "Processing…", iteration: 1 },
      { type: "tool_use", id: "tu_1", name: "codespar_pay", input: { amount: 500 } },
    ]);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const full = frame("assistant_text", { content: "split across reads", iteration: 1 });
    const mid = Math.floor(full.length / 2);
    const { session } = await streamSession(
      okStream(chunkedStream(full.slice(0, mid), full.slice(mid))),
    );
    expect(await collect(session)).toEqual([
      { type: "assistant_text", content: "split across reads", iteration: 1 },
    ]);
  });

  it("skips unknown event types and still yields known ones", async () => {
    const { session } = await streamSession(
      okStream(
        sseStream(
          frame("future_event_type_we_do_not_know", { content: "?" }),
          frame("assistant_text", { content: "ok", iteration: 1 }),
        ),
      ),
    );
    expect(await collect(session)).toEqual([
      { type: "assistant_text", content: "ok", iteration: 1 },
    ]);
  });

  it("yields a typed error event", async () => {
    const { session } = await streamSession(
      okStream(sseStream(frame("error", { error: "tool_failed", message: "asaas timed out" }))),
    );
    expect(await collect(session)).toEqual([
      { type: "error", error: "tool_failed", message: "asaas timed out" },
    ]);
  });

  it("throws 'sendStream failed' on non-ok response", async () => {
    const { session } = await streamSession({
      ok: false,
      status: 503,
      text: async () => "unavailable",
      body: null,
    });
    await expect(
      (async () => {
        for await (const _ of session.sendStream("hi")) void _;
      })(),
    ).rejects.toThrow(/sendStream failed: 503/);
  });

  // NOTE: `tool_result` and `done` (envelope events) and malformed-SSE
  // handling are intentionally NOT covered here. Porting the Python
  // streaming tests surfaced a systemic TS↔Python `parseSseChunk` drift
  // (no envelope unwrap; malformed frames silently dropped) — escalated as
  // codespar/codespar-core#51 and #53. The parser fix plus real Python-parity
  // assertions for those paths land together in the parser-alignment PR,
  // not as bug-pinning tests here.
});
