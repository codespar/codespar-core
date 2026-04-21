/**
 * Session implementation for the CodeSpar managed runtime.
 */

import type { SessionConfig, Tool } from "./types.js";
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
} from "@codespar/types";

interface SessionDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
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

  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ servers: req.servers, user_id: userId }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createSession failed: ${res.status} ${body}`);
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

    async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
      const start = Date.now();
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/execute`, {
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
          duration: Date.now() - start,
          server: "",
          tool: toolName,
        };
      }
      const result = (await r.json()) as ToolResult;
      return result;
    },

    async proxyExecute(request: ProxyRequest): Promise<ProxyResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/proxy_execute`, {
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
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`proxyExecute failed: ${r.status} ${body}`);
      }
      return (await r.json()) as ProxyResult;
    },

    async send(message: string): Promise<SendResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/send`, {
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
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/send`, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify({ message }),
      });
      if (!r.ok || !r.body) {
        const body = await r.text();
        throw new Error(`sendStream failed: ${r.status} ${body}`);
      }
      yield* parseSseStream(r.body);
    },

    async authorize(serverId: string, config: AuthConfig): Promise<AuthResult> {
      const r = await fetch(`${baseUrl}/v1/connect/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          server_id: serverId,
          user_id: data.user_id,
          redirect_uri: config.redirectUri,
          scopes: config.scopes,
        }),
      });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`authorize failed: ${r.status} ${body}`);
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

    async connections(): Promise<ServerConnection[]> {
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/connections`, {
        headers,
      });
      if (!r.ok) return cachedConnections ?? [];
      const payload = (await r.json()) as BackendConnectionsResponse;
      cachedConnections = payload.servers;
      cachedTools = payload.tools;
      return payload.servers;
    },

    async close(): Promise<void> {
      await fetch(`${baseUrl}/v1/sessions/${data.id}`, {
        method: "DELETE",
        headers,
      });
    },
  };

  if (config.manageConnections?.waitForConnections) {
    const timeout = config.manageConnections.timeout ?? 30000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const conns = await session.connections();
      if (conns.every((c) => c.connected)) break;
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
): AsyncIterable<StreamEvent> {
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
        const event = parseSseChunk(chunk);
        if (event) yield event;
      }
    }
    if (buffer.trim()) {
      const event = parseSseChunk(buffer);
      if (event) yield event;
    }
  } finally {
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

function presetToServers(preset: SessionConfig["preset"]): string[] {
  if (!preset) return ["zoop", "nuvem-fiscal"]; // sensible default for sandbox
  return PRESET_SERVERS[preset];
}
