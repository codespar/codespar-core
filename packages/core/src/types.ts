import { z } from "zod";

/* ── Configuration ─────────────────────────────────────────────── */

export interface CodeSparConfig {
  /** API key for managed mode. Obtain from dashboard.codespar.dev */
  apiKey?: string;
  /** Base URL for CodeSpar API. Defaults to https://api.codespar.dev */
  baseUrl?: string;
}

/* ── Session ──────────────────────────────────────────────────── */

export interface SessionConfig {
  /** MCP servers to connect, by id (e.g. "zoop", "nuvem-fiscal") */
  servers?: string[];
  /** Preset configurations. "brazilian" enables BR commerce servers. */
  preset?: "brazilian" | "mexican" | "argentinian" | "colombian" | "all";
  /** Connection management options */
  manageConnections?: {
    /** Block until all servers are connected */
    waitForConnections?: boolean;
    /** Timeout in ms for connection wait. Default: 30000 */
    timeout?: number;
  };
  /** Metadata attached to every tool call in this session */
  metadata?: Record<string, string>;
}

export interface Session {
  /** Unique session ID (e.g. "ses_HZb4d5yxIAxLawb4") */
  id: string;
  /** User ID that owns this session */
  userId: string;
  /** IDs of the servers attached to this session */
  servers: string[];
  /** Session creation timestamp */
  createdAt: Date;
  /** Session status */
  status: "active" | "closed" | "error";

  /**
   * MCP transport endpoint for this session. Pass to @codespar/mcp helpers
   * (getClaudeDesktopConfig, getCursorConfig) to generate config files for
   * MCP-compatible clients.
   *
   * Note: the runtime MCP endpoint is not yet implemented in the backend
   * (planned for Marco 3). The URL is provided so config generators can
   * produce the correct values today; runtime connection will work once
   * the backend MCP transport ships.
   */
  mcp: { url: string; headers: Record<string, string> };

  /**
   * Get tools available in this session. Loads from the backend on first
   * call and caches. Call connections() to refresh.
   */
  tools(): Promise<Tool[]>;

  /**
   * Find tools by intent description. Loads tools first if not cached.
   */
  findTools(intent: string): Promise<Tool[]>;

  /**
   * Execute a specific tool by name. Tool calls are logged on the
   * backend with input + output for billing and audit.
   */
  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;

  /** Run a Complete Loop workflow. */
  loop(config: LoopConfig): Promise<LoopResult>;

  /**
   * Send a natural-language message. Drives a Claude tool-use loop on
   * the backend and returns the full transcript when done.
   */
  send(message: string): Promise<SendResult>;

  /**
   * Stream a natural-language message. Yields events as the agent
   * runs (assistant text, tool_use, tool_result, done).
   */
  sendStream(message: string): AsyncIterable<StreamEvent>;

  /**
   * Initiate OAuth flow for a server.
   * @deprecated Not implemented in 0.2.0 — coming in Marco 3.
   */
  authorize(serverId: string, config?: AuthConfig): Promise<AuthResult>;

  /**
   * List server connections + available tools. Refreshes the internal
   * tools cache as a side effect.
   */
  connections(): Promise<ServerConnection[]>;

  /** Close session and release resources. */
  close(): Promise<void>;
}

/* ── Tools ────────────────────────────────────────────────────── */

export interface Tool {
  /** Tool name (e.g. "codespar_pay") */
  name: string;
  /** Human-readable description shown to LLMs */
  description: string;
  /** JSON Schema for tool inputs */
  input_schema: Record<string, unknown>;
  /** Server that provides this tool (for routing/billing). May be "codespar" for meta-tools. */
  server: string;
}

export interface ToolResult {
  /** Whether the call succeeded */
  success: boolean;
  /** Tool output (varies by tool) */
  data: unknown;
  /** Error message if failed */
  error: string | null;
  /** Execution time in ms */
  duration: number;
  /** Server that executed the tool */
  server: string;
  /** Tool that was executed */
  tool: string;
  /** Backend tool-call id for cross-referencing logs */
  tool_call_id?: string;
  /** Timestamp the call was logged */
  called_at?: string;
}

/* ── Complete Loop ────────────────────────────────────────────── */

export interface LoopStep {
  /** Tool name to execute */
  tool: string;
  /** Tool parameters */
  params: Record<string, unknown> | ((prevResults: ToolResult[]) => Record<string, unknown>);
  /** Optional: skip this step if condition returns false */
  when?: (prevResults: ToolResult[]) => boolean;
}

export interface LoopConfig {
  /** Steps to execute in order */
  steps: LoopStep[];
  /** Called after each step completes */
  onStepComplete?: (step: LoopStep, result: ToolResult, index: number) => void;
  /** Called if a step fails */
  onStepError?: (step: LoopStep, error: Error, index: number) => void;
  /** Retry policy for failed steps */
  retryPolicy?: {
    maxRetries?: number;
    backoff?: "linear" | "exponential";
    baseDelay?: number;
  };
  /** Abort all remaining steps on first failure. Default: true */
  abortOnError?: boolean;
}

export interface LoopResult {
  success: boolean;
  /** Results from each step, in order */
  results: ToolResult[];
  /** Total execution time in ms */
  duration: number;
  /** Number of steps completed */
  completedSteps: number;
  /** Total steps attempted */
  totalSteps: number;
}

/* ── Auth ─────────────────────────────────────────────────────── */

export interface AuthConfig {
  /** API key for direct auth */
  token?: string;
  /** OAuth2 client credentials */
  clientId?: string;
  clientSecret?: string;
}

export interface AuthResult {
  /** Whether auth was successful */
  connected: boolean;
  /** OAuth redirect URL (if OAuth flow required) */
  redirectUrl?: string;
  /** Error message if failed */
  error?: string;
}

/* ── Server connections ───────────────────────────────────────── */

export interface ServerConnection {
  /** Server id (e.g. "zoop") */
  id: string;
  /** Display name */
  name: string;
  /** Category (payments, fiscal, ecommerce, etc.) */
  category: string;
  /** Country code (BR, MX, AR, CO, GLOBAL) */
  country: string;
  /** Auth method */
  auth_type: "oauth" | "api_key" | "cert" | "none";
  /** Whether the server is connected and tools are callable */
  connected: boolean;
}

/* ── Send (natural language) ──────────────────────────────────── */

export interface SendResult {
  /** Final agent message text */
  message: string;
  /** Tools called during the run, in order */
  tool_calls: ToolCallRecord[];
  /** How many model iterations the loop ran */
  iterations: number;
}

/**
 * Single tool-call record returned by send / sendStream.
 * Mirrors the backend's session_tool_calls row shape.
 */
export interface ToolCallRecord {
  id: string;
  tool_name: string;
  server_id: string;
  status: "success" | "error";
  duration_ms: number;
  input: unknown;
  output: unknown;
  error_code: string | null;
}

/* ── Streaming events (sendStream) ─────────────────────────────── */

export type StreamEvent =
  | { type: "user_message"; content: string }
  | { type: "assistant_text"; content: string; iteration: number }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCall: ToolCallRecord }
  | { type: "done"; result: SendResult }
  | { type: "error"; error: string; message?: string };

/* ── Validation schemas ───────────────────────────────────────── */

export const SessionConfigSchema = z.object({
  servers: z.array(z.string()).optional(),
  preset: z.enum(["brazilian", "mexican", "argentinian", "colombian", "all"]).optional(),
  manageConnections: z
    .object({
      waitForConnections: z.boolean().optional(),
      timeout: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string()).optional(),
});
