import { z } from "zod";

/* ── Configuration ── */

export interface CodeSparConfig {
  /** API key for managed mode. Obtain from dashboard.codespar.dev */
  apiKey?: string;
  /** Base URL for CodeSpar API. Defaults to https://api.codespar.dev */
  baseUrl?: string;
  /** Enable managed mode (billing, logging, rate limiting via CodeSpar backend) */
  managed?: boolean;
}

/* ── Session ── */

export interface SessionConfig {
  /** MCP servers to connect. Use package names or IDs. */
  servers?: string[];
  /** Preset configurations. "brazilian" enables all BR servers. */
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
  /** Unique session ID */
  id: string;
  /** User ID that owns this session */
  userId: string;
  /** Connected servers */
  servers: ServerConnection[];
  /** Session creation timestamp */
  createdAt: Date;
  /** Get all available tools from connected servers */
  tools(): Tool[];
  /** Find tools by intent description */
  findTools(intent: string): Tool[];
  /** Execute a specific tool */
  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  /** Run a Complete Loop workflow */
  loop(config: LoopConfig): Promise<LoopResult>;
  /** Send a natural language message for the agent to process */
  send(message: string): Promise<SendResult>;
  /** Initiate OAuth flow for a server */
  authorize(serverId: string, config?: AuthConfig): Promise<AuthResult>;
  /** List connected servers and their auth status */
  connections(): Promise<ServerConnection[]>;
  /** MCP transport URLs for IDE integration */
  mcp: { url: string; headers: Record<string, string> };
  /** Close session and clean up resources */
  close(): Promise<void>;
}

/* ── Tools ── */

export interface Tool {
  /** Fully qualified tool name (e.g., ZOOP_CREATE_CHARGE) */
  name: string;
  /** Tool slug for execution */
  slug: string;
  /** Human-readable description */
  description: string;
  /** Server that provides this tool */
  server: string;
  /** Input schema (JSON Schema) */
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
  /** Execution time in ms */
  duration: number;
  /** Server that executed the tool */
  server: string;
  /** Tool that was executed */
  tool: string;
}

/* ── Complete Loop ── */

export interface LoopStep {
  /** Server ID or package name */
  server: string;
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

/* ── Auth ── */

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

/* ── Server ── */

export interface ServerConnection {
  /** Server ID */
  id: string;
  /** Server display name */
  name: string;
  /** npm package name */
  pkg: string;
  /** Whether the server is connected and ready */
  connected: boolean;
  /** Auth method used */
  auth: "oauth2" | "api_key" | "none";
  /** Number of tools available */
  toolCount: number;
}

/* ── Send (natural language) ── */

export interface SendResult {
  /** Agent response text */
  text: string;
  /** Tools that were called */
  toolCalls: ToolResult[];
  /** Total execution time in ms */
  duration: number;
}

/* ── Validation schemas ── */

export const SessionConfigSchema = z.object({
  servers: z.array(z.string()).optional(),
  preset: z.enum(["brazilian", "mexican", "argentinian", "colombian", "all"]).optional(),
  manageConnections: z.object({
    waitForConnections: z.boolean().optional(),
    timeout: z.number().optional(),
  }).optional(),
  metadata: z.record(z.string()).optional(),
});
