import type {
  Session,
  SessionConfig,
  Tool,
  ToolResult,
  LoopConfig,
  LoopResult,
  AuthConfig,
  AuthResult,
  ServerConnection,
  SendResult,
} from "./types.js";

interface SessionDeps {
  baseUrl: string;
  apiKey: string;
  managed: boolean;
}

export async function createSession(
  userId: string,
  config: SessionConfig,
  deps: SessionDeps
): Promise<Session> {
  const { baseUrl, apiKey, managed } = deps;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // Create session on backend
  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ userId, ...config }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create session: ${res.status} ${body}`);
  }

  const data = await res.json() as {
    id: string;
    servers: ServerConnection[];
    mcp: { url: string; headers: Record<string, string> };
  };

  let cachedTools: Tool[] | null = null;

  const session: Session = {
    id: data.id,
    userId,
    servers: data.servers,
    createdAt: new Date(),
    mcp: data.mcp,

    tools(): Tool[] {
      if (cachedTools) return cachedTools;
      // Tools are loaded lazily on first call
      throw new Error("Call await session.connections() first to load tools, or use session.findTools()");
    },

    findTools(intent: string): Tool[] {
      if (!cachedTools) return [];
      const q = intent.toLowerCase();
      return cachedTools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.server.toLowerCase().includes(q)
      );
    },

    async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
      const start = Date.now();
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: toolName, params }),
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

      const result = await r.json() as ToolResult;
      return { ...result, duration: result.duration || Date.now() - start };
    },

    async loop(loopConfig: LoopConfig): Promise<LoopResult> {
      const start = Date.now();
      const results: ToolResult[] = [];
      const maxRetries = loopConfig.retryPolicy?.maxRetries ?? 0;
      const abortOnError = loopConfig.abortOnError ?? true;

      for (let i = 0; i < loopConfig.steps.length; i++) {
        const step = loopConfig.steps[i];

        // Check conditional
        if (step.when && !step.when(results)) {
          continue;
        }

        // Resolve params (can be a function of previous results)
        const params =
          typeof step.params === "function" ? step.params(results) : step.params;

        let lastError: Error | null = null;
        let result: ToolResult | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            result = await session.execute(step.tool, params);
            if (result.success) {
              lastError = null;
              break;
            }
            lastError = new Error(result.error || "Tool execution failed");
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
          }

          // Backoff before retry
          if (attempt < maxRetries) {
            const baseDelay = loopConfig.retryPolicy?.baseDelay ?? 1000;
            const delay =
              loopConfig.retryPolicy?.backoff === "exponential"
                ? baseDelay * Math.pow(2, attempt)
                : baseDelay * (attempt + 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (lastError || !result?.success) {
          if (loopConfig.onStepError) {
            loopConfig.onStepError(step, lastError || new Error("Unknown error"), i);
          }
          if (result) results.push(result);
          if (abortOnError) {
            return {
              success: false,
              results,
              duration: Date.now() - start,
              completedSteps: results.filter((r) => r.success).length,
              totalSteps: loopConfig.steps.length,
            };
          }
          continue;
        }

        results.push(result);
        if (loopConfig.onStepComplete) {
          loopConfig.onStepComplete(step, result, i);
        }
      }

      return {
        success: results.every((r) => r.success),
        results,
        duration: Date.now() - start,
        completedSteps: results.filter((r) => r.success).length,
        totalSteps: loopConfig.steps.length,
      };
    },

    async send(message: string): Promise<SendResult> {
      const start = Date.now();
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message }),
      });

      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Send failed: ${r.status} ${body}`);
      }

      const result = await r.json() as SendResult;
      return { ...result, duration: result.duration || Date.now() - start };
    },

    async authorize(serverId: string, authConfig?: AuthConfig): Promise<AuthResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/authorize`, {
        method: "POST",
        headers,
        body: JSON.stringify({ serverId, ...authConfig }),
      });

      if (!r.ok) {
        return { connected: false, error: `Auth failed: ${r.status}` };
      }

      return r.json() as Promise<AuthResult>;
    },

    async connections(): Promise<ServerConnection[]> {
      const r = await fetch(`${baseUrl}/v1/sessions/${data.id}/connections`, { headers });
      if (!r.ok) return session.servers;

      const connections = await r.json() as { servers: ServerConnection[]; tools: Tool[] };
      session.servers = connections.servers;
      cachedTools = connections.tools;
      return connections.servers;
    },

    async close(): Promise<void> {
      await fetch(`${baseUrl}/v1/sessions/${data.id}`, {
        method: "DELETE",
        headers,
      });
    },
  };

  // If waitForConnections, poll until ready
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
