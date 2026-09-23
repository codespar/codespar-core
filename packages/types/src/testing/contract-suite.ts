import { describe, it, expect, afterEach } from "vitest";
import type { SessionBase, StreamEvent, ToolResult, SendResult, BaseConnection } from "../index.js";

/** One leg of the session contract suite. */
export type ContractLeg = "execute" | "send" | "sendStream" | "connections" | "close";

/** Options for {@link runContractSuite}. */
export interface ContractSuiteOptions {
  /**
   * Server ids to post when opening the session. Defaults to `[]`, matching a
   * consumer that brings no servers and relies on whatever the backend
   * provisions by default.
   */
  servers?: string[];
  /**
   * Which legs to register. Defaults to all five legs in declaration order.
   * Pass a subset to run only those legs (e.g. a consumer whose backend does
   * not implement streaming can omit `"sendStream"`).
   */
  legs?: ContractLeg[];
}

/** Every leg, in the order they are registered for a default run. */
const ALL_LEGS: readonly ContractLeg[] = [
  "execute",
  "send",
  "sendStream",
  "connections",
  "close",
];

/**
 * Resolve which legs to run from the options. Returns all five legs (in
 * declaration order) when `legs` is unset, otherwise the provided subset.
 */
export function selectLegs(opts?: ContractSuiteOptions): ContractLeg[] {
  return opts?.legs ? [...opts.legs] : [...ALL_LEGS];
}

/** Build the session-create request body, defaulting `servers` to `[]`. */
export function buildSessionCreateBody(opts?: ContractSuiteOptions): {
  servers: string[];
  user_id: string;
} {
  return { servers: opts?.servers ?? [], user_id: "contract-suite" };
}

export class InvalidBaseUrlError extends Error {
  constructor(url: string) {
    super(
      `Invalid base URL "${url}" — must use https:// protocol unless the host is localhost`,
    );
    this.name = "InvalidBaseUrlError";
  }
}

/**
 * Validate a backend base URL before any request is issued: only https://
 * URLs and localhost are accepted, so a misconfigured environment fails
 * early rather than leaking the apiKey to an arbitrary host. Shared by the
 * meta-tool conformance kit.
 */
export function validateBaseUrl(rawUrl: string): void {
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

/** The fields of the `POST /v1/sessions` 201 body that the SDK reads. */
export interface CreatedSessionBody {
  id: string;
  status: "active" | "closed" | "error";
  user_id: string;
  servers: string[];
  created_at: string;
}

/** The fields of the `GET /v1/sessions/:id/connections` body that the SDK reads. */
export interface ConnectionsBody {
  servers: BaseConnection[];
  tools: unknown[];
}

/**
 * Pin the 201 body to the shape `@codespar/sdk` builds its session from.
 * The SDK assigns `user_id`, `servers` and `created_at` without checking
 * them (`createdAt: new Date(data.created_at)`), so a runtime that returns
 * only `{ id, status }` produces an Invalid Date and undefined fields
 * rather than an error. Asserting here makes every leg fail loudly on such
 * a runtime instead of passing on a session the SDK could not use.
 *
 * `servers` is checked for containment, not equality: a runtime may
 * provision defaults on top of what the caller posted, but must not drop
 * what was posted.
 */
export function assertCreatedSessionShape(
  status: number,
  body: unknown,
  posted: { servers: string[]; user_id: string },
): CreatedSessionBody {
  expect(status, "POST /v1/sessions must answer 201 Created").toBe(201);
  expect(
    body,
    "201 body must carry id, status: active, the posted user_id, servers and created_at",
  ).toMatchObject({
    id: expect.any(String),
    status: "active",
    user_id: posted.user_id,
    servers: expect.any(Array),
    created_at: expect.any(String),
  });
  const raw = body as CreatedSessionBody;
  for (const id of raw.servers) {
    expect(typeof id, "servers must be a string[]").toBe("string");
  }
  expect(raw.servers, "servers must include every id the caller posted").toEqual(
    expect.arrayContaining(posted.servers),
  );
  expect(
    Number.isNaN(Date.parse(raw.created_at)),
    `created_at must parse as a date, got ${JSON.stringify(raw.created_at)}`,
  ).toBe(false);
  return raw;
}

/**
 * Pin the connections body to what the SDK caches from it: `servers` (each
 * at least a `BaseConnection`) and `tools`. The SDK assigns `payload.tools`
 * straight into its tool cache, so a body without it is a cache that never
 * fills, not an empty catalogue.
 */
export function assertConnectionsShape(body: unknown): ConnectionsBody {
  expect(body, "connections body must carry servers[] and tools[]").toMatchObject({
    servers: expect.any(Array),
    tools: expect.any(Array),
  });
  const raw = body as ConnectionsBody;
  for (const c of raw.servers) {
    expect(c, "each server entry must carry id and connected").toMatchObject({
      id: expect.any(String),
      connected: expect.any(Boolean),
    });
  }
  return raw;
}

// Builds a minimal SessionBase from raw fetch calls so the contract suite
// can run against any backend that implements the codespar session API.
async function openSession(
  baseUrl: string,
  apiKey: string,
  opts?: ContractSuiteOptions,
): Promise<SessionBase> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const createBody = buildSessionCreateBody(opts);
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(createBody),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`session create failed: ${res.status} ${text}`);
  }
  const raw = assertCreatedSessionShape(res.status, await res.json(), createBody);
  const state = { id: raw.id, status: raw.status };

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
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`connections failed: ${r.status} ${body}`);
      }
      return assertConnectionsShape(await r.json()).servers;
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
 * The optional `opts` argument lets a consumer choose which servers to post on
 * session open and which subset of legs to run. With no `opts` (or with neither
 * field set) the suite behaves exactly as before: it posts `servers: []` and
 * registers all five legs in declaration order.
 *
 * @param baseUrl - API base URL (e.g. "https://your-runtime.example" or "http://localhost:3000")
 * @param apiKey  - Bearer token for session creation
 * @param opts    - Optional servers list and leg selection (see {@link ContractSuiteOptions})
 */
export function runContractSuite(
  baseUrl: string,
  apiKey: string,
  opts?: ContractSuiteOptions,
): void {
  validateBaseUrl(baseUrl);

  const legs = new Set(selectLegs(opts));

  describe("session contract suite", () => {
    let session: SessionBase | null = null;

    afterEach(async () => {
      try {
        if (session) await session.close();
      } finally {
        session = null;
      }
    });

    if (legs.has("execute")) {
      it("execute() calls a registered tool and returns a ToolResult", async () => {
        session = await openSession(baseUrl, apiKey, opts);
        const result = await session.execute("codespar_list_tools", {});
        // codespar_list_tools is a built-in that always succeeds, so this is
        // a no-error result: error is the canonical `null` (matching the
        // published `error: string | null` wire type), not `""`. Asserting
        // `null` pins both runtimes to the same no-error value — an earlier
        // `expect.anything()` here both read backwards (it demanded a
        // non-null error on a success) and masked an OSS/managed divergence,
        // since `expect.anything()` rejects `null`.
        expect(result).toMatchObject({
          success: true,
          data: expect.anything(),
          error: null,
          duration: expect.any(Number),
          server: expect.any(String),
          tool: expect.any(String),
        });
      });
    }

    if (legs.has("send")) {
      it("send() returns a SendResult with a message field", async () => {
        session = await openSession(baseUrl, apiKey, opts);
        const result = await session.send("hello");
        expect(result).toMatchObject({
          message: expect.any(String),
          tool_calls: expect.any(Array),
          iterations: expect.any(Number),
        });
      });
    }

    if (legs.has("sendStream")) {
      it("sendStream() yields well-typed StreamEvents including done", async () => {
        session = await openSession(baseUrl, apiKey, opts);
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
    }

    if (legs.has("connections")) {
      it("connections() returns entries with id and connected fields", async () => {
        session = await openSession(baseUrl, apiKey, opts);
        const conns = await session.connections();
        expect(Array.isArray(conns)).toBe(true);
        for (const c of conns) {
          expect(typeof c.id).toBe("string");
          expect(typeof c.connected).toBe("boolean");
        }
      });
    }

    if (legs.has("close")) {
      it("close() transitions session.status to closed", async () => {
        session = await openSession(baseUrl, apiKey, opts);
        expect(session.status).toBe("active");
        await session.close();
        expect(session.status).toBe("closed");
        session = null; // afterEach guard — already closed
      });
    }
  });
}
