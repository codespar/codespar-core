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

describe("session.sendStream — SSE parsing", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /send with SSE Accept header and serialized message body", async () => {
    const { session, m } = await streamSession({
      ok: true,
      status: 200,
      text: async () => "",
      body: sseStream(frame("done", { message: "ok", tool_calls: [], iterations: 1 })),
    });
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

  it("yields typed events; characterizes the tool_result wrapper drift (#53)", async () => {
    // tool_result frame uses the Python/canonical wrapper shape
    // { type, toolCall: { …ToolCallRecord… } } — the same shape Python's
    // _parse_stream_event reads via raw["toolCall"].
    const toolCallRecord = {
      id: "tc_1",
      tool_name: "codespar_pay",
      server_id: "asaas",
      status: "success",
      duration_ms: 412,
      input: { amount: 500 },
      output: { pix_id: "pix_1" },
      error_code: null,
    };
    const { session } = await streamSession({
      ok: true,
      status: 200,
      text: async () => "",
      body: sseStream(
        frame("assistant_text", { content: "Processing…", iteration: 1 }),
        frame("tool_use", { id: "tu_1", name: "codespar_pay", input: { amount: 500 } }),
        frame("tool_result", { type: "tool_result", toolCall: toolCallRecord }),
        frame("done", { message: "Done.", tool_calls: [], iterations: 1 }),
      ),
    });
    const events: StreamEvent[] = [];
    for await (const e of session.sendStream("charge R$500 via Pix")) events.push(e);

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "assistant_text", content: "Processing…", iteration: 1 });
    expect(events[1]).toMatchObject({ type: "tool_use", name: "codespar_pay", input: { amount: 500 } });

    const tr = events[2] as Extract<StreamEvent, { type: "tool_result" }>;
    expect(tr.type).toBe("tool_result");
    // DRIFT CHARACTERIZATION (#53): TS parseSseChunk does `toolCall: data`,
    // so it wraps the WHOLE data object — it does NOT unwrap data.toolCall
    // like Python does. Against the canonical wrapper payload, the record
    // ends up one level too deep and `tr.toolCall.tool_name` is undefined.
    // This pins the real (buggy) TS behavior; alignment is tracked in #53.
    expect((tr.toolCall as { tool_name?: string }).tool_name).toBeUndefined();
    expect(tr.toolCall as unknown).toEqual({ type: "tool_result", toolCall: toolCallRecord });

    expect(events[3]).toEqual({
      type: "done",
      result: { message: "Done.", tool_calls: [], iterations: 1 },
    });
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    const full = frame("assistant_text", { content: "split across reads", iteration: 1 });
    const mid = Math.floor(full.length / 2);
    const { session } = await streamSession({
      ok: true,
      status: 200,
      text: async () => "",
      body: chunkedStream(full.slice(0, mid), full.slice(mid)),
    });
    const events: StreamEvent[] = [];
    for await (const e of session.sendStream("hi")) events.push(e);
    expect(events).toEqual([
      { type: "assistant_text", content: "split across reads", iteration: 1 },
    ]);
  });

  it("skips unknown event types and still yields known ones", async () => {
    const { session } = await streamSession({
      ok: true,
      status: 200,
      text: async () => "",
      body: sseStream(
        frame("future_event_type_we_do_not_know", { content: "?" }),
        frame("assistant_text", { content: "ok", iteration: 1 }),
      ),
    });
    const events: StreamEvent[] = [];
    for await (const e of session.sendStream("hi")) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "assistant_text", content: "ok" });
  });

  it("yields a typed error event", async () => {
    const { session } = await streamSession({
      ok: true,
      status: 200,
      text: async () => "",
      body: sseStream(frame("error", { error: "tool_failed", message: "asaas timed out" })),
    });
    const events: StreamEvent[] = [];
    for await (const e of session.sendStream("hi")) events.push(e);
    expect(events).toEqual([{ type: "error", error: "tool_failed", message: "asaas timed out" }]);
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

  // DESIRED-CONTRACT test, marked `.fails` because the contract is not met
  // yet (tracked in #51). It asserts the *correct* behavior: a malformed
  // non-JSON `data:` frame must raise, mirroring Python's
  // test_streaming.py::test_send_stream_raises_on_malformed_data
  // (`raise StreamError`). Today TS `parseSseChunk` silently returns null
  // and drops the frame, so the inner assertion fails and `it.fails` keeps
  // the suite green while surfacing this as known debt. When #51 is fixed
  // (TS raises/emits error), the inner assertion passes, `it.fails` then
  // FAILS — forcing whoever fixes the parser to drop `.fails` and close
  // #51 deliberately. This never blesses the silent-drop as spec.
  it.fails(
    "should raise on malformed (non-JSON) SSE data, mirroring Python StreamError — FIXME(#51)",
    async () => {
      const { session } = await streamSession({
        ok: true,
        status: 200,
        text: async () => "",
        body: sseStream(
          "event: broken\ndata: this-is-not-json\n\n",
          frame("assistant_text", { content: "still here", iteration: 1 }),
        ),
      });
      await expect(
        (async () => {
          for await (const _ of session.sendStream("hi")) void _;
        })(),
      ).rejects.toThrow();
    },
  );
});
