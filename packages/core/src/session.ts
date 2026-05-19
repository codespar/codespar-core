/**
 * Session implementation for the CodeSpar managed runtime.
 */

import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import type { SessionConfig, Tool, CallOptions } from "./types.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import { mergeSignals } from "./internal/abort.js";
import type {
  Session,
  CreateSessionRequest,
  ToolResult,
  AuthConfig,
  AuthResult,
  ServerConnection,
  SendResult,
  StreamEvent,
  ProxyRequest,
  ProxyResult,
  DiscoverOptions,
  DiscoverResult,
  ConnectionWizardOptions,
  ConnectionWizardResult,
  PaymentStatusResult,
  PaymentStatusStreamOptions,
  VerificationStatusResult,
  VerificationStatusStreamOptions,
  ChargeArgs,
  ChargeResult,
  ShipArgs,
  ShipResult,
  LedgerArgs,
  LedgerResult,
  IssueArgs,
  IssueResult,
  ShopArgs,
  ShopResult,
} from "@codespar/types";

interface SessionDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

// Every unary transport site funnels through here. The `consume`
// callback reads the body inside the timeout/abort budget (via
// fetchWithTimeout), so a backend that stalls the body still hits the
// deadline. Network rejections become CodesparApiError (status: 0);
// typed timeouts and caller aborts propagate verbatim; structured API
// errors raised inside `consume` (throwFromResponse) pass through
// unwrapped. Streaming sites use raw fetch (SSE idle-timeout lives at
// the stream layer), not this helper.
async function safeFetch<T>(
  input: string,
  init: Omit<RequestInit, "signal">,
  what: string,
  timeoutOpts: { timeout: number; signal?: AbortSignal },
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  try {
    return await fetchWithTimeout(input, init, timeoutOpts, consume);
  } catch (cause) {
    if (cause instanceof TimeoutError) throw cause;
    if (cause instanceof CodesparApiError) throw cause;
    if (timeoutOpts.signal?.aborted) throw cause;
    throw networkErrorToApiError(cause, what);
  }
}

interface BackendSessionResponse {
  id: string;
  org_id: string;
  user_id: string;
  servers: string[];
  status: "active" | "closed" | "error";
  created_at: string;
  closed_at: string | null;
}

interface BackendConnectionsResponse {
  servers: ServerConnection[];
  tools: Tool[];
}

// The concrete session object satisfies the Session interface and carries extra
// internal methods (tools, findTools) that the free functions in tools.ts access
// via duck-typing. They are intentionally not declared on the Session interface.
export async function createSession(
  userId: string,
  config: SessionConfig,
  deps: SessionDeps,
  createOpts?: CallOptions,
): Promise<Session> {
  const { baseUrl, apiKey } = deps;
  const projectId = config.projectId ?? deps.projectId;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (projectId) headers["x-codespar-project"] = projectId;

  const req: CreateSessionRequest = {
    servers: config.servers ?? presetToServers(config.preset),
    metadata: config.metadata,
    projectId: config.projectId ?? deps.projectId,
  };

  // Resolve per-call timeout/abort against the client default. Kept local
  // so every method funnels through one place if CallOptions grows.
  const callOpts = (o?: CallOptions) => ({
    timeout: o?.timeout ?? deps.timeout,
    signal: o?.signal,
  });

  // Conditional spread keeps the wire body byte-identical to the
  // pre-PRD shape when the caller omits mocks (R18 wire-neutrality).
  // The field is forwarded verbatim — no canonical-name rewriting on
  // the SDK side, so the double-underscore migration trap surfaces
  // as the backend's mocks_invalid envelope rather than silent
  // SDK-side normalization.
  const wireBody: Record<string, unknown> = {
    servers: req.servers,
    user_id: userId,
    ...(config.mocks !== undefined ? { mocks: config.mocks } : {}),
  };
  const data = await safeFetch(
    `${baseUrl}/v1/sessions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(wireBody),
    },
    "createSession",
    callOpts(createOpts),
    async (res) => {
      if (!res.ok) await throwFromResponse(res, "createSession");
      return (await res.json()) as BackendSessionResponse;
    },
  );

  let cachedTools: Tool[] | null = null;
  let cachedConnections: ServerConnection[] | null = null;

  const session = {
    id: data.id,
    userId: data.user_id,
    servers: data.servers,
    createdAt: new Date(data.created_at),
    status: data.status,
    // Placeholder MCP transport URL — runtime endpoint lands in Marco 3.
    // Kept here so @codespar/mcp config helpers work today.
    mcp: {
      url: `${baseUrl}/v1/sessions/${data.id}/mcp`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(projectId ? { "x-codespar-project": projectId } : {}),
      },
    },

    async tools(): Promise<Tool[]> {
      if (cachedTools) return cachedTools;
      await session.connections();
      return cachedTools ?? [];
    },

    async findTools(intent: string): Promise<Tool[]> {
      const all = await session.tools();
      const q = intent.toLowerCase();
      return all.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q),
      );
    },

    async execute(toolName: string, params: Record<string, unknown>, opts?: CallOptions): Promise<ToolResult> {
      const start = Date.now();
      return await safeFetch(
        `${baseUrl}/v1/sessions/${data.id}/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ tool: toolName, input: params }),
        },
        "execute",
        callOpts(opts),
        async (r) => {
          if (!r.ok) {
            const body = await r.text();
            return {
              success: false,
              data: null,
              error: `${r.status}: ${body}`,
              duration: Date.now() - start,
              server: "",
              tool: toolName,
            };
          }
          return (await r.json()) as ToolResult;
        },
      );
    },

    async proxyExecute(request: ProxyRequest, opts?: CallOptions): Promise<ProxyResult> {
      return await safeFetch(
        `${baseUrl}/v1/sessions/${data.id}/proxy_execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            server: request.server,
            endpoint: request.endpoint,
            method: request.method,
            body: request.body,
            params: request.params,
            headers: request.headers,
          }),
        },
        "proxyExecute",
        callOpts(opts),
        async (r) => {
          if (!r.ok) await throwFromResponse(r, "proxyExecute");
          return (await r.json()) as ProxyResult;
        },
      );
    },

    async send(message: string, opts?: CallOptions): Promise<SendResult> {
      return await safeFetch(
        `${baseUrl}/v1/sessions/${data.id}/send`,
        {
          method: "POST",
          headers: { ...headers, Accept: "application/json" },
          body: JSON.stringify({ message }),
        },
        "send",
        callOpts(opts),
        async (r) => {
          if (!r.ok) await throwFromResponse(r, "send");
          return (await r.json()) as SendResult;
        },
      );
    },

    async *sendStream(message: string, opts?: CallOptions): AsyncIterable<StreamEvent> {
      const ms = opts?.timeout ?? deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, opts?.signal]);
      const idle = makeIdle(idleAc, ms);
      try {
        // Arm the timeout before the fetch so the connect/headers phase
        // is covered too — not just post-body idle. Otherwise a backend
        // that accepts the socket but never sends headers hangs forever.
        idle.reset();
        const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/send`, {
          method: "POST",
          headers: { ...headers, Accept: "text/event-stream" },
          body: JSON.stringify({ message }),
          signal: merged.signal,
        });
        if (!r.ok || !r.body) {
          await throwFromResponse(r, "sendStream");
        }
        // r.body is non-null here — throwFromResponse always throws.
        yield* parseSseStream(r.body!, idle, merged.signal);
      } catch (err) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (idleAc.signal.aborted) throw new TimeoutError(ms);
        // Structured API errors propagate; only raw transport rejections
        // collapse to CodesparApiError(status: 0), matching safeFetch.
        if (err instanceof CodesparApiError) throw err;
        throw networkErrorToApiError(err, "sendStream");
      } finally {
        idle.pause();
        merged.cleanup();
      }
    },

    /**
     * codespar_discover wrapper. Same wire as
     * `execute("codespar_discover", {...})` but returns a typed
     * DiscoverResult so the caller doesn't have to cast.
     */
    async discover(
      useCase: string,
      options?: DiscoverOptions,
      opts?: CallOptions,
    ): Promise<DiscoverResult> {
      const result = await session.execute("codespar_discover", {
        use_case: useCase,
        ...(options ?? {}),
      }, opts);
      if (!result.success) {
        throw new Error(`discover failed: ${result.error ?? "unknown"}`);
      }
      return result.data as DiscoverResult;
    },

    /**
     * codespar_manage_connections wrapper. Same wire as
     * `execute("codespar_manage_connections", {...})` but returns a
     * typed ConnectionWizardResult — a UI component receives it
     * verbatim and renders the wizard. Defaults `action` to "list"
     * when no server_id is given, "status" otherwise (matching the
     * backend default).
     */
    async connectionWizard(
      options: ConnectionWizardOptions,
      opts?: CallOptions,
    ): Promise<ConnectionWizardResult> {
      const result = await session.execute(
        "codespar_manage_connections",
        options as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`connectionWizard failed: ${result.error ?? "unknown"}`);
      }
      return result.data as ConnectionWizardResult;
    },

    /**
     * codespar_charge wrapper. Inbound charge — buyer pays merchant.
     * Same wire as `execute("codespar_charge", {...})` but returns a
     * typed ChargeResult so the caller doesn't have to cast through
     * ToolResult.data. Distinct from the legacy `codespar_pay` rail
     * (which routes to outbound transfers/payouts).
     */
    async charge(args: ChargeArgs, opts?: CallOptions): Promise<ChargeResult> {
      const result = await session.execute(
        "codespar_charge",
        args as unknown as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`charge failed: ${result.error ?? "unknown"}`);
      }
      return result.data as ChargeResult;
    },

    /**
     * codespar_ship wrapper. Generate a label, fetch tracking, or
     * calculate carrier rates via a unified shape. Same wire as
     * `execute("codespar_ship", {...})` but returns a typed
     * ShipResult so the caller doesn't have to cast through
     * ToolResult.data.
     */
    async ship(args: ShipArgs, opts?: CallOptions): Promise<ShipResult> {
      const result = await session.execute(
        "codespar_ship",
        args as unknown as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`ship failed: ${result.error ?? "unknown"}`);
      }
      return result.data as ShipResult;
    },

    /**
     * codespar_ledger wrapper. Post a double-entry journal entry, read
     * an account's balances, or create an account on the tenant's
     * self-hosted Midaz ledger. Same wire as
     * `execute("codespar_ledger", {...})` but returns a typed
     * LedgerResult so the caller doesn't have to cast through
     * ToolResult.data.
     */
    async ledger(args: LedgerArgs, opts?: CallOptions): Promise<LedgerResult> {
      const result = await session.execute(
        "codespar_ledger",
        args as unknown as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`ledger failed: ${result.error ?? "unknown"}`);
      }
      return result.data as LedgerResult;
    },

    /**
     * codespar_issue wrapper. Issue a virtual/physical card, control
     * (freeze/unfreeze/cancel) one, or read its status on the tenant's
     * Pomelo card-issuing program. Same wire as
     * `execute("codespar_issue", {...})` but returns a typed IssueResult.
     */
    async issue(args: IssueArgs, opts?: CallOptions): Promise<IssueResult> {
      const result = await session.execute(
        "codespar_issue",
        args as unknown as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`issue failed: ${result.error ?? "unknown"}`);
      }
      return result.data as IssueResult;
    },

    /**
     * codespar_shop wrapper. Catalog search → async checkout → Pix mint.
     * Same wire as `execute("codespar_shop", {...})` but returns a typed
     * ShopResult so the caller doesn't have to cast through
     * ToolResult.data. Checkout is async: `{action:"checkout"}` returns
     * `{checkout_session_id, status:"in_progress"}`; poll
     * `{action:"checkout_status", checkout_session_id}` until
     * `ready_for_payment` (carries `pix_copia_e_cola`) or `canceled`.
     *
     * Requires a runtime that implements the `codespar_shop` meta-tool
     * (a registered implementation behind the contract); a self-hosted
     * OSS runtime with none returns "Tool not registered".
     */
    async shop(args: ShopArgs, opts?: CallOptions): Promise<ShopResult> {
      const result = await session.execute(
        "codespar_shop",
        args as unknown as Record<string, unknown>,
        opts,
      );
      if (!result.success) {
        throw new Error(`shop failed: ${result.error ?? "unknown"}`);
      }
      return result.data as ShopResult;
    },

    async paymentStatus(toolCallId: string, opts?: CallOptions): Promise<PaymentStatusResult> {
      return await safeFetch(
        `${baseUrl}/v1/tool-calls/${encodeURIComponent(toolCallId)}/payment-status`,
        { headers },
        "paymentStatus",
        callOpts(opts),
        async (r) => {
          if (!r.ok) await throwFromResponse(r, "paymentStatus");
          return (await r.json()) as PaymentStatusResult;
        },
      );
    },

    async verificationStatus(
      toolCallId: string,
      opts?: CallOptions,
    ): Promise<VerificationStatusResult> {
      return await safeFetch(
        `${baseUrl}/v1/tool-calls/${encodeURIComponent(toolCallId)}/verification-status`,
        { headers },
        "verificationStatus",
        callOpts(opts),
        async (r) => {
          if (!r.ok) await throwFromResponse(r, "verificationStatus");
          return (await r.json()) as VerificationStatusResult;
        },
      );
    },

    async paymentStatusStream(
      toolCallId: string,
      options: PaymentStatusStreamOptions = {},
    ): Promise<PaymentStatusResult> {
      const ms = options.timeout ?? deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, options.signal]);
      const idle = makeIdle(idleAc, ms);
      try {
        // Arm the timeout before the fetch so connect/headers are covered.
        idle.reset();
        const url = `${baseUrl}/v1/tool-calls/${encodeURIComponent(
          toolCallId,
        )}/payment-status/stream`;
        const r = await fetch(url, {
          headers: { ...headers, Accept: "text/event-stream" },
          signal: merged.signal,
        });
        if (!r.ok || !r.body) {
          await throwFromResponse(r, "paymentStatusStream");
        }
        let last: PaymentStatusResult | null = null;
        // r.body is non-null here — throwFromResponse always throws.
        for await (const frame of parseStatusSseStream(r.body!, idle, merged.signal)) {
          if (frame.event === "snapshot" || frame.event === "update") {
            last = frame.data as PaymentStatusResult;
            options.onUpdate?.(last);
          } else if (frame.event === "done") {
            break;
          }
        }
        if (!last) {
          throw new Error("paymentStatusStream: stream closed before snapshot");
        }
        return last;
      } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (idleAc.signal.aborted) throw new TimeoutError(ms);
        if (err instanceof CodesparApiError) throw err;
        throw networkErrorToApiError(err, "paymentStatusStream");
      } finally {
        idle.pause();
        merged.cleanup();
      }
    },

    async verificationStatusStream(
      toolCallId: string,
      options: VerificationStatusStreamOptions = {},
    ): Promise<VerificationStatusResult> {
      const ms = options.timeout ?? deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, options.signal]);
      const idle = makeIdle(idleAc, ms);
      try {
        // Arm the timeout before the fetch so connect/headers are covered.
        idle.reset();
        const url = `${baseUrl}/v1/tool-calls/${encodeURIComponent(
          toolCallId,
        )}/verification-status/stream`;
        const r = await fetch(url, {
          headers: { ...headers, Accept: "text/event-stream" },
          signal: merged.signal,
        });
        if (!r.ok || !r.body) {
          await throwFromResponse(r, "verificationStatusStream");
        }
        let last: VerificationStatusResult | null = null;
        // r.body is non-null here — throwFromResponse always throws.
        for await (const frame of parseStatusSseStream(r.body!, idle, merged.signal)) {
          if (frame.event === "snapshot" || frame.event === "update") {
            last = frame.data as VerificationStatusResult;
            options.onUpdate?.(last);
          } else if (frame.event === "done") {
            break;
          }
        }
        if (!last) {
          throw new Error(
            "verificationStatusStream: stream closed before snapshot",
          );
        }
        return last;
      } catch (err) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (idleAc.signal.aborted) throw new TimeoutError(ms);
        if (err instanceof CodesparApiError) throw err;
        throw networkErrorToApiError(err, "verificationStatusStream");
      } finally {
        idle.pause();
        merged.cleanup();
      }
    },

    async authorize(serverId: string, config: AuthConfig, opts?: CallOptions): Promise<AuthResult> {
      const payload = await safeFetch(
        `${baseUrl}/v1/connect/start`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            server_id: serverId,
            user_id: data.user_id,
            redirect_uri: config.redirectUri,
            scopes: config.scopes,
          }),
        },
        "authorize",
        callOpts(opts),
        async (r) => {
          if (!r.ok) await throwFromResponse(r, "authorize");
          return (await r.json()) as {
            link_token: string;
            authorize_url: string;
            expires_at: string;
          };
        },
      );
      return {
        linkToken: payload.link_token,
        authorizeUrl: payload.authorize_url,
        expiresAt: payload.expires_at,
      };
    },

    async connections(opts?: CallOptions): Promise<ServerConnection[]> {
      // Best-effort — both transport failures (CodesparApiError from
      // safeFetch) and non-2xx responses fall back to the cached
      // payload so a transient blip doesn't crater the session.
      try {
        return await safeFetch(
          `${baseUrl}/v1/sessions/${data.id}/connections`,
          { headers },
          "connections",
          callOpts(opts),
          async (r) => {
            if (!r.ok) return cachedConnections ?? [];
            const payload = (await r.json()) as BackendConnectionsResponse;
            cachedConnections = payload.servers;
            cachedTools = payload.tools;
            return payload.servers;
          },
        );
      } catch {
        return cachedConnections ?? [];
      }
    },

    async close(opts?: CallOptions): Promise<void> {
      // Best-effort: the DELETE is bounded by the timeout/abort budget
      // so close() can't hang, but its outcome is swallowed so a slow
      // or failing backend cleanup never throws from a caller's
      // teardown/finally. Parity with the Python client (suppresses
      // ApiError + TimeoutError) and the managed-agents adapter (close
      // never throws). The backend reaps stale sessions on a timer.
      try {
        await safeFetch(
          `${baseUrl}/v1/sessions/${data.id}`,
          { method: "DELETE", headers },
          "close",
          callOpts(opts),
          async () => undefined,
        );
      } catch {
        // intentionally ignored — see above
      }
    },
  };

  if (config.manageConnections?.waitForConnections) {
    const timeout = config.manageConnections.timeout ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const conns = await session.connections();
      // `connections()` returns [] on a failed/empty response; an empty
      // list must NOT count as "all connected" — [].every() is vacuously
      // true and would resolve the gate with zero servers connected.
      if (conns.length > 0 && conns.every((c) => c.connected)) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return session;
}

/**
 * Parse a Server-Sent Events stream into typed StreamEvent objects.
 *
 * The backend emits events shaped like:
 *   event: assistant_text
 *   data: {"content":"...","iteration":1}
 *
 * which we map to discriminated-union StreamEvent values that the SDK
 * exports. We intentionally keep parsing tiny: split on double newlines,
 * pick out `event:` and `data:` lines, JSON-parse the data.
 */
/**
 * Idle-timeout controller. `reset()` (re-)arms the idle deadline;
 * `pause()` disarms it. The parsers pause the timer while control is
 * yielded to the consumer so slow per-event processing does NOT count
 * as transport idle, then reset it before awaiting the next read.
 */
interface IdleController {
  reset(): void;
  pause(): void;
}

function makeIdle(idleAc: AbortController, ms: number): IdleController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    reset() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => idleAc.abort(), ms);
    },
    pause() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  idle: IdleController,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Single abort promise + single listener per parser call — avoids
  // per-iteration listener accumulation and MaxListeners warnings.
  let abortReject!: (e: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  const onAbort = () => abortReject(signal.reason);
  if (signal.aborted) {
    queueMicrotask(() => abortReject(signal.reason));
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    idle.reset();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // A complete SSE comment frame (":..." heartbeat) carries no
        // data but IS protocol liveness — reset idle. Only an
        // incomplete byte trickle (no "\n\n" yet) must still time out.
        if (chunk.startsWith(":")) {
          idle.reset();
          continue;
        }
        const event = parseSseChunk(chunk);
        if (event) {
          // Pause while the consumer processes the event so its
          // processing time is not counted as transport idle; re-arm
          // once control returns, before the next read.
          idle.pause();
          yield event;
          idle.reset();
        }
      }
    }
    if (buffer.trim()) {
      const event = parseSseChunk(buffer);
      if (event) {
        // Same invariant as the inner loop: pause the idle timer
        // while the consumer holds control. The stream has ended, so
        // there is no read to re-arm for afterwards.
        idle.pause();
        yield event;
      }
    }
  } finally {
    idle.pause();
    signal.removeEventListener("abort", onAbort);
    // Best-effort, NON-blocking: a degraded ReadableStream may return a
    // cancel() promise that never settles; awaiting it here would delay
    // delivery of the very TimeoutError/abort the caller is waiting for.
    void Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function parseSseChunk(chunk: string): StreamEvent | null {
  let eventName = "message";
  let dataLine = "";
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!dataLine) return null;
  let data: unknown;
  try {
    data = JSON.parse(dataLine);
  } catch {
    return null;
  }

  switch (eventName) {
    case "user_message":
      return { type: "user_message", content: (data as { content: string }).content };
    case "assistant_text":
      return {
        type: "assistant_text",
        content: (data as { content: string }).content,
        iteration: (data as { iteration: number }).iteration,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: (data as { id: string }).id,
        name: (data as { name: string }).name,
        input: (data as { input: Record<string, unknown> }).input,
      };
    case "tool_result":
      return { type: "tool_result", toolCall: data as never };
    case "done":
      return { type: "done", result: data as SendResult };
    case "error":
      return {
        type: "error",
        error: (data as { error: string }).error,
        message: (data as { message?: string }).message,
      };
    default:
      return null;
  }
}

const PRESET_SERVERS: Record<NonNullable<SessionConfig["preset"]>, string[]> = {
  brazilian: ["zoop", "nuvem-fiscal", "melhor-envio", "z-api", "omie"],
  mexican: ["conekta", "facturapi", "skydropx"],
  argentinian: ["afip", "andreani"],
  colombian: ["wompi", "siigo", "coordinadora"],
  all: [
    "zoop",
    "nuvem-fiscal",
    "melhor-envio",
    "z-api",
    "omie",
    "conekta",
    "facturapi",
    "afip",
    "wompi",
  ],
};

/**
 * Generic SSE parser for the status streams. Distinct from
 * `parseSseStream` above because the chat-loop variant maps frames
 * onto a discriminated `StreamEvent` union, while the status streams
 * just need raw `{event, data}` pairs the caller's typed wrapper
 * casts via the route-level envelope shape.
 */
async function* parseStatusSseStream(
  body: ReadableStream<Uint8Array>,
  idle: IdleController,
  signal: AbortSignal,
): AsyncIterable<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Single abort promise + single listener per parser call — avoids
  // per-iteration listener accumulation and MaxListeners warnings.
  let abortReject!: (e: unknown) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  const onAbort = () => abortReject(signal.reason);
  if (signal.aborted) {
    queueMicrotask(() => abortReject(signal.reason));
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    idle.reset();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // Comment frames (heartbeats) start with ":" and carry no
        // data, but a complete heartbeat frame IS protocol liveness —
        // reset idle so healthy long-pending streams don't time out
        // (parity with Python httpx, whose read timeout any byte
        // resets). An incomplete byte trickle still times out because
        // it never forms a "\n\n" frame.
        if (chunk.startsWith(":")) {
          idle.reset();
          continue;
        }
        let eventName = "message";
        let dataLine = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLine);
        } catch {
          continue;
        }
        // Pause while the consumer processes the frame; re-arm after.
        idle.pause();
        yield { event: eventName, data: parsed };
        idle.reset();
      }
    }
  } finally {
    idle.pause();
    signal.removeEventListener("abort", onAbort);
    // Best-effort, NON-blocking: a degraded ReadableStream may return a
    // cancel() promise that never settles; awaiting it here would delay
    // delivery of the very TimeoutError/abort the caller is waiting for.
    void Promise.resolve(reader.cancel()).catch(() => {});
    reader.releaseLock();
  }
}

function presetToServers(preset: SessionConfig["preset"]): string[] {
  if (!preset) return ["zoop", "nuvem-fiscal"]; // sensible default for sandbox
  return PRESET_SERVERS[preset];
}
