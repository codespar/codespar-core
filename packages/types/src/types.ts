/* ── Runtime-agnostic session base ─────────────────────────────── */

export interface SessionBase {
  readonly id: string;
  readonly status: "active" | "closed" | "error";
  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  send(message: string): Promise<SendResult>;
  sendStream(message: string): AsyncIterable<StreamEvent>;
  connections(): Promise<BaseConnection[]>;
  close(): Promise<void>;
}

/* ── Codespar-specific session (extends base) ──────────────────── */

export interface Session extends SessionBase {
  proxyExecute(request: ProxyRequest): Promise<ProxyResult>;
  authorize(serverId: string, config: AuthConfig): Promise<AuthResult>;
  mcp?: { url: string; headers: Record<string, string> };
}

/* ── Connections ───────────────────────────────────────────────── */

export type BaseConnection = { id: string; connected: boolean };

export interface ServerConnection {
  id: string;
  name: string;
  category: string;
  country: string;
  auth_type: "oauth" | "api_key" | "cert" | "none";
  connected: boolean;
}

/* ── Session creation ─────────────────────────────────────────── */

export interface CreateSessionRequest {
  servers: string[];
  metadata?: Record<string, string>;
  projectId?: string;
}

/* ── Tool execution ─────────────────────────────────────────────── */

export interface ToolResult {
  success: boolean;
  data: unknown;
  error: string | null;
  duration: number;
  server: string;
  tool: string;
  tool_call_id?: string;
  called_at?: string;
}

/* ── Natural language send ──────────────────────────────────────── */

export interface SendResult {
  message: string;
  tool_calls: ToolCallRecord[];
  iterations: number;
}

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

/* ── Proxy (raw HTTP passthrough) ───────────────────────────────── */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ProxyRequest {
  server: string;
  endpoint: string;
  method: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export interface ProxyResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  duration: number;
  proxy_call_id?: string;
}

/* ── Auth ─────────────────────────────────────────────────────── */

export interface AuthConfig {
  redirectUri: string;
  scopes?: string;
}

export interface AuthResult {
  linkToken: string;
  authorizeUrl: string;
  expiresAt: string;
}
