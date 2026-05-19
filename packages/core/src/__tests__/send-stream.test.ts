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
      okStream(sseStream(frame("done", { message: "ok", tool_calls: [], iterations: 1 }))),
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

  // ─── DRIFT TRIPWIRES ────────────────────────────────────────────────
  // Normal passing tests that PIN today's TS-buggy behavior NARROWLY:
  // ordinary assertions first prove the stream reached the point (so
  // unrelated breakage fails normally and is NOT masked), then ONE precise
  // assertion of the current drifted value. When the parser is aligned
  // (#51 / #53) that precise value changes and the test FAILS LOUDLY,
  // forcing the fixer to delete the tripwire and close the issue. These
  // assert the *current defect*, never bless it as desired spec — the
  // names/comments and the linked issues make the intent explicit.

  it("DRIFT TRIPWIRE #51 — malformed (non-JSON) SSE frame is silently dropped, no throw (must change only via #51)", async () => {
    const { session } = await streamSession(
      okStream(
        sseStream(
          "event: broken\ndata: this-is-not-json\n\n",
          frame("assistant_text", { content: "still here", iteration: 1 }),
        ),
      ),
    );
    let threw: unknown;
    const events: StreamEvent[] = [];
    try {
      for await (const e of session.sendStream("hi")) events.push(e);
    } catch (e) {
      threw = e;
    }
    if (threw !== undefined) {
      throw new Error(
        `#51 appears FIXED — sendStream now throws on malformed SSE (${String(
          threw,
        )}). Replace this tripwire with a parity assertion vs Python StreamError ` +
          `(/malformed SSE payload/) and close codespar/codespar-core#51.`,
      );
    }
    // Current TS defect: broken frame dropped, stream continues to the next.
    expect(events).toEqual([
      { type: "assistant_text", content: "still here", iteration: 1 },
    ]);
  });

  it("DRIFT TRIPWIRE #53 — tool_result is not unwrapped: toolCall holds the whole envelope (must change only via #53)", async () => {
    const record = {
      id: "tc_1",
      tool_name: "codespar_pay",
      server_id: "asaas",
      status: "success",
      duration_ms: 412,
      input: { amount: 500 },
      output: { pix_id: "pix_1" },
      error_code: null,
    };
    // Canonical Python/backend wire shape: { type, toolCall: { …record… } }.
    const { session } = await streamSession(
      okStream(sseStream(frame("tool_result", { type: "tool_result", toolCall: record }))),
    );
    const events = await collect(session);
    expect(events).toHaveLength(1);
    const tr = events[0] as Extract<StreamEvent, { type: "tool_result" }>;
    expect(tr.type).toBe("tool_result");
    if ((tr.toolCall as { tool_name?: string }).tool_name === "codespar_pay") {
      throw new Error(
        "#53 appears FIXED — tool_result now unwraps data.toolCall. Replace this " +
          "tripwire with the canonical ToolCallRecord assertion and close codespar/codespar-core#53.",
      );
    }
    // Current TS defect: `toolCall: data`, so it is the whole envelope.
    expect(tr.toolCall as unknown).toEqual({ type: "tool_result", toolCall: record });
  });

  it("DRIFT TRIPWIRE #53 — done is not unwrapped: result holds the whole envelope (must change only via #53)", async () => {
    const sendResult = { message: "Done.", tool_calls: [], iterations: 1 };
    // Canonical Python/backend wire shape: { type, result: { …SendResult… } }.
    const { session } = await streamSession(
      okStream(sseStream(frame("done", { type: "done", result: sendResult }))),
    );
    const events = await collect(session);
    expect(events).toHaveLength(1);
    const dn = events[0] as Extract<StreamEvent, { type: "done" }>;
    expect(dn.type).toBe("done");
    if ((dn.result as { message?: string }).message === "Done.") {
      throw new Error(
        "#53 appears FIXED — done now unwraps data.result. Replace this tripwire " +
          "with the canonical SendResult assertion and close codespar/codespar-core#53.",
      );
    }
    // Current TS defect: `result: data`, so it is the whole envelope.
    expect(dn.result as unknown).toEqual({ type: "done", result: sendResult });
  });
});
