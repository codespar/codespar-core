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
} from "@codespar/session-contract";

import {
  type PolicyDecision,
  InvalidToolNameError,
  PolicyViolationError,
  ApprovalRequiredError,
  ConcurrentOperationError,
  DrainTimeoutError,
} from "./errors.js";

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

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
  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (this._activeMutex) throw new ConcurrentOperationError();

    // Tool name validation runs before any message is constructed so a
    // newline or whitespace character cannot inject instructions into the
    // JSON payload sent to the Managed Agents API.
    if (!TOOL_NAME_RE.test(toolName)) throw new InvalidToolNameError(toolName);

    // PolicyHook evaluates original params — must precede sanitizeParams.
    if (this._policyHook) {
      const decision = await this._policyHook.evaluate(this._agentId, toolName);
      if (!decision.allowed) throw new PolicyViolationError(decision);
      if (decision.requiresApproval) throw new ApprovalRequiredError(decision);
    }

    const resolvedParams = this._sanitizeParams
      ? this._sanitizeParams(params)
      : params;

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      const message = JSON.stringify({ tool: toolName, input: resolvedParams });
      await this._runtime.sendMessage(this._sessionId, message);
      const deadline = Date.now() + this._drainTimeoutMs;
      return await this._drainForToolResult(deadline, toolName);
    } finally {
      resolveMutex();
      this._activeMutex = null;
    }
  }

  async send(message: string): Promise<SendResult> {
    if (this._activeMutex) throw new ConcurrentOperationError();

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      await this._runtime.sendMessage(this._sessionId, message);
      return await this._drainForSendResult();
    } finally {
      resolveMutex();
      this._activeMutex = null;
    }
  }

  async *sendStream(message: string): AsyncIterable<StreamEvent> {
    if (this._activeMutex) throw new ConcurrentOperationError();

    let resolveMutex!: () => void;
    this._activeMutex = new Promise<void>((r) => {
      resolveMutex = r;
    });
    try {
      await this._runtime.sendMessage(this._sessionId, message);
      for await (const raw of this._runtime.streamEvents(this._sessionId)) {
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

  async connections(): Promise<BaseConnection[]> {
    const status = await this._runtime.getStatus(this._sessionId);
    return [{ id: this._sessionId, connected: status.state === "active" }];
  }

  async close(): Promise<void> {
    this._status = "closed";
    if (this._activeMutex) await this._activeMutex;
  }

  private async _drainForToolResult(deadline: number, toolName: string): Promise<ToolResult> {
    for await (const raw of this._runtime.streamEvents(this._sessionId)) {
      if (Date.now() > deadline) throw new DrainTimeoutError(this._drainTimeoutMs);
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

  private async _drainForSendResult(): Promise<SendResult> {
    const toolCalls: SendResult["tool_calls"] = [];
    let finalResult: SendResult | null = null;

    for await (const raw of this._runtime.streamEvents(this._sessionId)) {
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
