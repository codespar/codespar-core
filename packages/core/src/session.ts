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

// Wraps `fetch` so network rejections become CodesparApiError
// (status: 0) at the very edge of the SDK, rather than bubbling
// raw TypeError / DOMException up to the caller. Every transport
// site in this file goes through here.
async function safeFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  what: string,
  timeoutOpts?: { timeout: number; signal?: AbortSignal },
): Promise<Response> {
  try {
    // Unary callers pass timeoutOpts → total timeout + cancellation;
    // streaming callers omit it and use plain fetch (SSE idle-timeout
    // is handled at the stream layer, not here).
    if (timeoutOpts) {
      return await fetchWithTimeout(
        input as string,
        init as Omit<RequestInit, "signal">,
        timeoutOpts,
      );
    }
    return await fetch(input, init);
  } catch (cause) {
    // Typed timeout + caller aborts propagate verbatim; only genuine
    // transport rejections collapse to CodesparApiError(status: 0).
    if (cause instanceof TimeoutError) throw cause;
    if (timeoutOpts?.signal?.aborted) throw cause;
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
  const res = await safeFetch(
    `${baseUrl}/v1/sessions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(wireBody),
    },
    "createSession",
    callOpts(),
  );
  if (!res.ok) {
    await throwFromResponse(res, "createSession");
  }
  const data = (await res.json()) as BackendSessionResponse;

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
      const r = await safeFetch(
        `${baseUrl}/v1/sessions/${data.id}/execute`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ tool: toolName, input: params }),
        },
        "execute",
        callOpts(opts),
      );
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
      const result = (await r.json()) as ToolResult;
      return result;
    },

    async proxyExecute(request: ProxyRequest, opts?: CallOptions): Promise<ProxyResult> {
      const r = await safeFetch(
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
      );
      if (!r.ok) {
        await throwFromResponse(r, "proxyExecute");
      }
      return (await r.json()) as ProxyResult;
    },

    async send(message: string, opts?: CallOptions): Promise<SendResult> {
      const r = await safeFetch(
        `${baseUrl}/v1/sessions/${data.id}/send`,
        {
          method: "POST",
          headers: { ...headers, Accept: "application/json" },
          body: JSON.stringify({ message }),
        },
        "send",
        callOpts(opts),
      );
      if (!r.ok) {
        await throwFromResponse(r, "send");
      }
      return (await r.json()) as SendResult;
    },

    async *sendStream(message: string, opts?: CallOptions): AsyncIterable<StreamEvent> {
      const ms = opts?.timeout ?? deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, opts?.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => idleAc.abort(), ms);
      };
      try {
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
        yield* parseSseStream(r.body!, resetIdle, merged.signal);
      } catch (err) {
        if (opts?.signal?.aborted) throw opts.signal.reason;
        if (idleAc.signal.aborted) throw new TimeoutError(ms);
        // Structured API errors propagate; only raw transport rejections
        // collapse to CodesparApiError(status: 0), matching safeFetch.
        if (err instanceof CodesparApiError) throw err;
        throw networkErrorToApiError(err, "sendStream");
      } finally {
        if (timer) clearTimeout(timer);
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
      const r = await safeFetch(
        `${baseUrl}/v1/tool-calls/${encodeURIComponent(toolCallId)}/payment-status`,
        { headers },
        "paymentStatus",
        callOpts(opts),
      );
      if (!r.ok) {
        await throwFromResponse(r, "paymentStatus");
      }
      return (await r.json()) as PaymentStatusResult;
    },

    async verificationStatus(
      toolCallId: string,
      opts?: CallOptions,
    ): Promise<VerificationStatusResult> {
      const r = await safeFetch(
        `${baseUrl}/v1/tool-calls/${encodeURIComponent(toolCallId)}/verification-status`,
        { headers },
        "verificationStatus",
        callOpts(opts),
      );
      if (!r.ok) {
        await throwFromResponse(r, "verificationStatus");
      }
      return (await r.json()) as VerificationStatusResult;
    },

    async paymentStatusStream(
      toolCallId: string,
      options: PaymentStatusStreamOptions = {},
    ): Promise<PaymentStatusResult> {
      const ms = deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, options.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => idleAc.abort(), ms);
      };
      try {
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
        for await (const frame of parseStatusSseStream(r.body!, resetIdle, merged.signal)) {
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
        if (timer) clearTimeout(timer);
        merged.cleanup();
      }
    },

    async verificationStatusStream(
      toolCallId: string,
      options: VerificationStatusStreamOptions = {},
    ): Promise<VerificationStatusResult> {
      const ms = deps.timeout;
      const idleAc = new AbortController();
      const merged = mergeSignals([idleAc.signal, options.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => idleAc.abort(), ms);
      };
      try {
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
        for await (const frame of parseStatusSseStream(r.body!, resetIdle, merged.signal)) {
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
        if (timer) clearTimeout(timer);
        merged.cleanup();
      }
    },

    async authorize(serverId: string, config: AuthConfig, opts?: CallOptions): Promise<AuthResult> {
      const r = await safeFetch(
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
      );
      if (!r.ok) {
        await throwFromResponse(r, "authorize");
      }
      const payload = (await r.json()) as {
        link_token: string;
        authorize_url: string;
        expires_at: string;
      };
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
        const r = await safeFetch(
          `${baseUrl}/v1/sessions/${data.id}/connections`,
          { headers },
          "connections",
          callOpts(opts),
        );
        if (!r.ok) return cachedConnections ?? [];
        const payload = (await r.json()) as BackendConnectionsResponse;
        cachedConnections = payload.servers;
        cachedTools = payload.tools;
        return payload.servers;
      } catch {
        return cachedConnections ?? [];
      }
    },

    async close(): Promise<void> {
      // Best-effort — the backend reaps stale sessions on a timer,
      // so a network failure here shouldn't surface to the caller.
      try {
        await safeFetch(
          `${baseUrl}/v1/sessions/${data.id}`,
          { method: "DELETE", headers },
          "close",
        );
      } catch {
        // Intentional swallow — matches the previous fire-and-forget
        // contract; close() never threw.
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
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  resetIdle: () => void,
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
    resetIdle();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseSseChunk(chunk);
        if (event) yield event;
      }
    }
    if (buffer.trim()) {
      const event = parseSseChunk(buffer);
      if (event) yield event;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // reader already errored/closed — cancel is best-effort
    }
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
  resetIdle: () => void,
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
    resetIdle();
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        // Comment frames (heartbeats) start with ":" and carry no data.
        if (chunk.startsWith(":")) continue;
        let eventName = "message";
        let dataLine = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        try {
          yield { event: eventName, data: JSON.parse(dataLine) };
        } catch {
          continue;
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // reader already errored/closed — cancel is best-effort
    }
    reader.releaseLock();
  }
}

function presetToServers(preset: SessionConfig["preset"]): string[] {
  if (!preset) return ["zoop", "nuvem-fiscal"]; // sensible default for sandbox
  return PRESET_SERVERS[preset];
}
