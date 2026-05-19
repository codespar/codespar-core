// Pre-GA stub for the Anthropic Managed Agents SDK AgentRuntime type.
// When the official SDK exports a stable AgentRuntime, replace this interface
// with: import type { AgentRuntime } from "@anthropic-ai/managed-agents";
export interface AgentRuntime {
  createSession(config: { agentId: string; environmentId: string }): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  getStatus(sessionId: string): Promise<{ state: string }>;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

import type {
  SessionBase,
  ToolResult,
  SendResult,
  StreamEvent,
  BaseConnection,
  CallOptions,
} from "@codespar/types";

import {
  type PolicyDecision,
  InvalidToolNameError,
  PolicyViolationError,
  ApprovalRequiredError,
  ConcurrentOperationError,
  DrainTimeoutError,
  SessionClosedError,
} from "./errors.js";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** Throw the caller's abort reason verbatim if the signal is aborted. */
function throwIfAborted(opts?: CallOptions): void {
  if (opts?.signal?.aborted) throw opts.signal.reason;
}

/**
 * Fail-fast per-call timeout validation, parity with the core SDK's
 * validateTimeout and the Python normalize_timeout. MUST run before
 * any runtime dispatch so an invalid value can never start a
 * (possibly non-idempotent) commerce side effect before rejecting.
 */
function resolveDrainMs(timeout: number | undefined, fallback: number): number {
  const ms = timeout ?? fallback;
  if (
    typeof ms !== "number" ||
    Number.isNaN(ms) ||
    !Number.isFinite(ms) ||
    ms <= 0
  ) {
    throw new Error(
      `timeout must be a positive, finite number of milliseconds, got ${String(ms)}`,
    );
  }
  return ms;
}

/**
 * Race a promise against an absolute deadline and caller abort. Used
 * for EVERY potentially-unbounded await on the per-call budget path
 * (sendMessage and each stream read) so a stalled runtime can never
 * pin the call — or the session mutex — past its timeout/abort.
 */
async function guarded<T>(
  p: Promise<T>,
  deadline: number,
  drainMs: number,
  opts: CallOptions | undefined,
): Promise<T> {
  if (opts?.signal?.aborted) throw opts.signal.reason;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DrainTimeoutError(drainMs);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DrainTimeoutError(drainMs)), remaining);
    if (opts?.signal) {
      onAbort = () => reject(opts.signal!.reason);
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // If p wins the race the guard stays pending and would reject
  // later — swallow that so it never surfaces as an unhandled rejection.
  guard.catch(() => {});

  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && opts?.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Drain an async iterable while enforcing a SHARED absolute deadline
 * (covering sendMessage + every read) and caller abort on EVERY read —
 * including a read that never resolves because the runtime stalled
 * before yielding. The underlying iterator is always closed via
 * return() on early exit (fire-and-forget — a wedged generator must
 * not re-introduce the hang).
 */
async function* withDeadline<T>(
  source: AsyncIterable<T>,
  deadline: number,
  drainMs: number,
  opts: CallOptions | undefined,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const res = await guarded(it.next(), deadline, drainMs, opts);
      if (res.done) return;
      yield res.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}

export interface PolicyHook {
  evaluate(agentId: string, toolName: string): Promise<PolicyDecision>;
}

export interface ManagedAgentsOptions {
  policyHook?: PolicyHook;
  /** Applied to params after policy evaluation, never before. */
  sanitizeParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  /** Milliseconds to wait for a tool result before throwing DrainTimeoutError. */
  drainTimeoutMs?: number;
}

export interface ManagedAgentsConfig {
  agentId: string;
  environmentId: string;
}

class ManagedAgentsSession implements SessionBase {
  readonly id: string;
  private _status: "active" | "closed" | "error";
  private _activeMutex: Promise<void> | null = null;
  private readonly _runtime: AgentRuntime;
  private readonly _sessionId: string;
  private readonly _agentId: string;
  private readonly _policyHook?: PolicyHook;
  private readonly _sanitizeParams?: (p: Record<string, unknown>) => Record<string, unknown>;
  private readonly _drainTimeoutMs: number;

  constructor(
    runtime: AgentRuntime,
    sessionId: string,
    agentId: string,
    options: ManagedAgentsOptions,
  ) {
    this._runtime = runtime;
    this._sessionId = sessionId;
    this._agentId = agentId;
    this._policyHook = options.policyHook;
    this._sanitizeParams = options.sanitizeParams;
    this._drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.id = sessionId;
    this._status = "active";
  }

  get status(): "active" | "closed" | "error" {
    return this._status;
  }

  // Read through a method so TS does not narrow `_status` from an
  // earlier check — close() can flip it concurrently between awaits.
  private isClosed(): boolean {
    return this._status === "closed";
  }

  /**
   * Execute a named tool via the Managed Agents API.
   *
   * Policy evaluation (policyHook) runs on the original params BEFORE
   * sanitizeParams is applied. This ordering is intentional: sanitization
   * could strip fields (e.g. amount) that the policy uses to enforce
   * fund-transfer caps.
   *
   * Callers must NOT automatically retry after DrainTimeoutError. The remote
   * tool call may have already executed — retrying risks a duplicate
   * transaction (Pix transfer, NF-e issuance, etc.).
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    opts?: CallOptions,
  ): Promise<ToolResult> {
    throwIfAborted(opts);
    if (this.isClosed()) throw new SessionClosedError();
    if (this._activeMutex) throw new ConcurrentOperationError();

    // Tool name validation runs before any message is constructed so a
    // newline or whitespace character cannot inject instructions into the
    // JSON payload sent to the Managed Agents API.
    if (!TOOL_NAME_RE.test(toolName)) throw new InvalidToolNameError(toolName);

    // One budget spans the WHOLE call — policy eval, sendMessage, and
    // the drain — so a stall in any phase cannot escape timeout/abort
    // or pin the session mutex. Per-call timeout overrides the
    // configured drain timeout.
    const drainMs = resolveDrainMs(opts?.timeout, this._drainTimeoutMs);
    const deadline = Date.now() + drainMs;

    // PolicyHook evaluates original params — must precede sanitizeParams.
    // Deliberately NOT under the mutex: close() during policy must be
    // able to return promptly (it is terminal cleanup, not a barrier).
    // Safety against dispatching after close is the isClosed() check
    // below, right before sendMessage — not blocking close().
    if (this._policyHook) {
      const decision = await guarded(
        this._policyHook.evaluate(this._agentId, toolName),
        deadline,
        drainMs,
        opts,
      );
      if (!decision.allowed) throw new PolicyViolationError(decision);
      if (decision.requiresApproval) throw new ApprovalRequiredError(decision);
    }

    const resolvedParams = this._sanitizeParams
      ? this._sanitizeParams(params)
      : params;

    // close() may have been requested during the awaited policy phase —
    // never dispatch a (possibly non-idempotent) tool on a closed
    // session, even though close() itself already returned.
    if (this.isClosed()) throw new SessionClosedError();

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      const message = JSON.stringify({ tool: toolName, input: resolvedParams });
      await guarded(
        this._runtime.sendMessage(this._sessionId, message),
        deadline,
        drainMs,
        opts,
      );
      return await this._drainForToolResult(
        withDeadline(this._runtime.streamEvents(this._sessionId), deadline, drainMs, opts),
        toolName,
      );
    } finally {
      resolveMutex();
      this._activeMutex = null;
    }
  }

  async send(message: string, opts?: CallOptions): Promise<SendResult> {
    throwIfAborted(opts);
    if (this.isClosed()) throw new SessionClosedError();
    if (this._activeMutex) throw new ConcurrentOperationError();

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      const drainMs = resolveDrainMs(opts?.timeout, this._drainTimeoutMs);
      const deadline = Date.now() + drainMs;
      await guarded(
        this._runtime.sendMessage(this._sessionId, message),
        deadline,
        drainMs,
        opts,
      );
      return await this._drainForSendResult(
        withDeadline(this._runtime.streamEvents(this._sessionId), deadline, drainMs, opts),
      );
    } finally {
      resolveMutex();
      this._activeMutex = null;
    }
  }

  async *sendStream(
    message: string,
    opts?: CallOptions,
  ): AsyncIterable<StreamEvent> {
    throwIfAborted(opts);
    if (this.isClosed()) throw new SessionClosedError();
    if (this._activeMutex) throw new ConcurrentOperationError();

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      const drainMs = resolveDrainMs(opts?.timeout, this._drainTimeoutMs);
      const deadline = Date.now() + drainMs;
      await guarded(
        this._runtime.sendMessage(this._sessionId, message),
        deadline,
        drainMs,
        opts,
      );
      for await (const raw of withDeadline(
        this._runtime.streamEvents(this._sessionId),
        deadline,
        drainMs,
        opts,
      )) {
        if (typeof raw.type !== "string") continue;
        const event = mapAgentEvent(raw);
        if (event) yield event;
        if (raw.type === "done") break;
      }
    } finally {
      resolveMutex();
      this._activeMutex = null;
    }
  }

  async connections(opts?: CallOptions): Promise<BaseConnection[]> {
    const drainMs = resolveDrainMs(opts?.timeout, this._drainTimeoutMs);
    const status = await guarded(
      this._runtime.getStatus(this._sessionId),
      Date.now() + drainMs,
      drainMs,
      opts,
    );
    return [{ id: this._sessionId, connected: status.state === "active" }];
  }

  async close(opts?: CallOptions): Promise<void> {
    // close() is terminal cleanup — it never throws on timeout/abort.
    // It bounds the in-flight drain wait by BOTH signal and timeout so
    // a caller closing a session is never pinned behind a wedged op.
    this._status = "closed";
    if (!this._activeMutex) return;
    const drainMs = resolveDrainMs(opts?.timeout, this._drainTimeoutMs);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort && opts?.signal) opts.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const timer = setTimeout(done, drainMs);
      let onAbort: (() => void) | undefined;
      if (opts?.signal) {
        if (opts.signal.aborted) return done();
        onAbort = done;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      void this._activeMutex?.then(done, done);
    });
  }

  private async _drainForToolResult(
    source: AsyncIterable<AgentEvent>,
    toolName: string,
  ): Promise<ToolResult> {
    // Deadline + caller abort are enforced by withDeadline(source).
    for await (const raw of source) {
      if (typeof raw.type !== "string") continue;
      if (raw.type === "tool_result") {
        return {
          success: raw.success !== false,
          data: raw.data ?? null,
          error: typeof raw.error === "string" ? raw.error : null,
          duration: typeof raw.duration === "number" ? raw.duration : 0,
          server: typeof raw.server === "string" ? raw.server : "",
          tool: toolName,
        };
      }
      if (raw.type === "done") {
        throw new Error(`Session completed without producing a tool result for "${toolName}"`);
      }
    }
    throw new Error(`Stream ended without producing a tool result for "${toolName}"`);
  }

  private async _drainForSendResult(
    source: AsyncIterable<AgentEvent>,
  ): Promise<SendResult> {
    const toolCalls: SendResult["tool_calls"] = [];
    let finalResult: SendResult | null = null;

    // Deadline + caller abort are enforced by withDeadline(source).
    for await (const raw of source) {
      if (typeof raw.type !== "string") continue;
      if (raw.type === "tool_result") {
        const tc = raw.toolCall as SendResult["tool_calls"][number] | undefined;
        if (tc) toolCalls.push(tc);
      }
      if (raw.type === "done") {
        const result = raw.result as Partial<SendResult> | undefined;
        finalResult = {
          message: typeof result?.message === "string" ? result.message : "",
          tool_calls: result?.tool_calls ?? toolCalls,
          iterations: typeof result?.iterations === "number" ? result.iterations : 0,
        };
        break;
      }
    }

    if (!finalResult) {
      throw new Error("Stream ended without a done event");
    }
    return finalResult;
  }
}

function mapAgentEvent(raw: AgentEvent): StreamEvent | null {
  switch (raw.type) {
    case "user_message":
      return { type: "user_message", content: String(raw.content ?? "") };
    case "assistant_text":
      return {
        type: "assistant_text",
        content: String(raw.content ?? ""),
        iteration: typeof raw.iteration === "number" ? raw.iteration : 0,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: String(raw.id ?? ""),
        name: String(raw.name ?? ""),
        input: (raw.input as Record<string, unknown>) ?? {},
      };
    case "tool_result":
      return { type: "tool_result", toolCall: raw.toolCall as never };
    case "done":
      return { type: "done", result: raw.result as SendResult };
    case "error":
      return {
        type: "error",
        error: String(raw.error ?? "unknown error"),
        message: typeof raw.message === "string" ? raw.message : undefined,
      };
    default:
      return null;
  }
}

export async function createManagedAgentsSession(
  runtime: AgentRuntime,
  config: ManagedAgentsConfig,
  options: ManagedAgentsOptions = {},
): Promise<SessionBase> {
  const sessionId = await runtime.createSession(config);
  return new ManagedAgentsSession(runtime, sessionId, config.agentId, options);
}
