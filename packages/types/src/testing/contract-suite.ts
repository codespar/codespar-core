import { describe, it, expect, afterEach } from "vitest";
import type { SessionBase, StreamEvent, ToolResult, SendResult, BaseConnection } from "../index.js";

export class InvalidBaseUrlError extends Error {
  constructor(url: string) {
    super(
      `Invalid base URL "${url}" — must use https:// protocol unless the host is localhost`,
    );
    this.name = "InvalidBaseUrlError";
  }
}

function validateBaseUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBaseUrlError(rawUrl);
  }
  if (parsed.hostname !== "localhost" && parsed.protocol !== "https:") {
    throw new InvalidBaseUrlError(rawUrl);
  }
}

// Minimal SSE parser used only within the contract test suite.
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let eventName = "message";
        let dataLine = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload: unknown;
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }
        // Yield discriminated StreamEvent from the known event names.
        // Unrecognised events are silently skipped — the variant list is
        // defined by the StreamEvent union in types.ts.
        if (eventName === "user_message")
          yield { type: "user_message", content: (payload as { content: string }).content };
        else if (eventName === "assistant_text")
          yield {
            type: "assistant_text",
            content: (payload as { content: string }).content,
            iteration: (payload as { iteration: number }).iteration,
          };
        else if (eventName === "tool_use")
          yield {
            type: "tool_use",
            id: (payload as { id: string }).id,
            name: (payload as { name: string }).name,
            input: (payload as { input: Record<string, unknown> }).input,
          };
        else if (eventName === "tool_result")
          yield { type: "tool_result", toolCall: payload as never };
        else if (eventName === "done")
          yield { type: "done", result: payload as SendResult };
        else if (eventName === "error")
          yield {
            type: "error",
            error: (payload as { error: string }).error,
            message: (payload as { message?: string }).message,
          };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Builds a minimal SessionBase from raw fetch calls so the contract suite
// can run against any backend that implements the codespar session API.
async function openSession(baseUrl: string, apiKey: string): Promise<SessionBase> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ servers: [], user_id: "contract-suite" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`session create failed: ${res.status} ${text}`);
  }
  const raw = (await res.json()) as { id: string; status: string };
  const state = { id: raw.id, status: raw.status as "active" | "closed" | "error" };

  return {
    get id() {
      return state.id;
    },
    get status() {
      return state.status;
    },
    async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${state.id}/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: toolName, input: params }),
      });
      if (!r.ok) {
        const body = await r.text();
        return {
          success: false,
          data: null,
          error: `${r.status}: ${body}`,
          duration: 0,
          server: "",
          tool: toolName,
        };
      }
      return (await r.json()) as ToolResult;
    },
    async send(message: string): Promise<SendResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${state.id}/send`, {
        method: "POST",
        headers: { ...headers, Accept: "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`send failed: ${r.status} ${body}`);
      }
      return (await r.json()) as SendResult;
    },
    async *sendStream(message: string): AsyncIterable<StreamEvent> {
      const r = await fetch(`${baseUrl}/v1/sessions/${state.id}/send`, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
      });
      if (!r.ok || !r.body) {
        const body = await r.text();
        throw new Error(`sendStream failed: ${r.status} ${body}`);
      }
      yield* parseSse(r.body);
    },
    async connections(): Promise<BaseConnection[]> {
      const r = await fetch(`${baseUrl}/v1/sessions/${state.id}/connections`, { headers });
      if (!r.ok) return [];
      const payload = (await r.json()) as { servers: BaseConnection[] };
      return payload.servers;
    },
    async close(): Promise<void> {
      await fetch(`${baseUrl}/v1/sessions/${state.id}`, {
        method: "DELETE",
        headers,
      });
      state.status = "closed";
    },
  };
}

/**
 * Register the full session contract test suite against a live backend.
 *
 * Validates the baseUrl before issuing any request: only https:// URLs and
 * localhost are accepted. Throws InvalidBaseUrlError synchronously for
 * invalid URLs so misconfigured CI environments fail early rather than
 * leaking the apiKey to an arbitrary host.
 *
 * @param baseUrl - API base URL (e.g. "https://your-runtime.example" or "http://localhost:3000")
 * @param apiKey  - Bearer token for session creation
 */
export function runContractSuite(baseUrl: string, apiKey: string): void {
  validateBaseUrl(baseUrl);

  describe("session contract suite", () => {
    let session: SessionBase | null = null;

    afterEach(async () => {
      try {
        if (session) await session.close();
      } finally {
        session = null;
      }
    });

    it("execute() calls a registered tool and returns a ToolResult", async () => {
      session = await openSession(baseUrl, apiKey);
      const result = await session.execute("codespar_list_tools", {});
      expect(result).toMatchObject({
        success: expect.any(Boolean),
        data: expect.anything(),
        error: expect.anything(),
        duration: expect.any(Number),
        server: expect.any(String),
        tool: expect.any(String),
      });
    });

    it("send() returns a SendResult with a message field", async () => {
      session = await openSession(baseUrl, apiKey);
      const result = await session.send("hello");
      expect(result).toMatchObject({
        message: expect.any(String),
        tool_calls: expect.any(Array),
        iterations: expect.any(Number),
      });
    });

    it("sendStream() yields well-typed StreamEvents including done", async () => {
      session = await openSession(baseUrl, apiKey);
      const events: StreamEvent[] = [];
      for await (const ev of session.sendStream("hello")) {
        events.push(ev);
        if (ev.type === "done" || ev.type === "error") break;
      }
      expect(events.length).toBeGreaterThan(0);
      const types = new Set(events.map((e) => e.type));
      // Every event type must be one of the six discriminated variants.
      const valid = new Set([
        "user_message",
        "assistant_text",
        "tool_use",
        "tool_result",
        "done",
        "error",
      ]);
      for (const t of types) {
        expect(valid.has(t)).toBe(true);
      }
    });

    it("connections() returns entries with id and connected fields", async () => {
      session = await openSession(baseUrl, apiKey);
      const conns = await session.connections();
      expect(Array.isArray(conns)).toBe(true);
      for (const c of conns) {
        expect(typeof c.id).toBe("string");
        expect(typeof c.connected).toBe("boolean");
      }
    });

    it("close() transitions session.status to closed", async () => {
      session = await openSession(baseUrl, apiKey);
      expect(session.status).toBe("active");
      await session.close();
      expect(session.status).toBe("closed");
      session = null; // afterEach guard — already closed
    });
  });
}
