import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, kv, success, table } from "../output.js";

interface SessionSummary {
  id: string;
  user_id?: string;
  status?: "active" | "closed" | "error";
  servers?: string[];
  created_at?: string;
  closed_at?: string;
  tool_call_count?: number;
}

interface ListOptions {
  status?: string;
  limit?: string;
  json?: boolean;
}

export async function listSessionsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get<{ data: SessionSummary[] }>("/v1/sessions", {
    status: opts.status,
    limit: opts.limit,
  });

  if (opts.json) {
    json(data.data);
    return;
  }

  table(
    ["ID", "USER", "STATUS", "SERVERS", "TOOL CALLS", "CREATED"],
    data.data.map((s) => [
      s.id,
      s.user_id ?? "-",
      s.status ?? "-",
      (s.servers ?? []).join(", "),
      String(s.tool_call_count ?? 0),
      s.created_at ? new Date(s.created_at).toISOString().slice(0, 19).replace("T", " ") : "-",
    ]),
  );
}

interface ShowOptions {
  json?: boolean;
  logs?: boolean;
}

interface LogEntry {
  id: string;
  tool: string;
  server: string;
  status: "success" | "error" | "running";
  duration_ms?: number;
  called_at?: string;
}

export async function showSessionCommand(
  client: ApiClient,
  id: string,
  opts: ShowOptions,
): Promise<void> {
  if (!id) throw new CliError("Session id is required.");

  const session = await client.get<SessionSummary>(`/v1/sessions/${encodeURIComponent(id)}`);

  if (opts.json) {
    if (opts.logs) {
      const logs = await client.get<{ data: LogEntry[] }>(`/v1/sessions/${encodeURIComponent(id)}/logs`);
      json({ session, logs: logs.data });
    } else {
      json(session);
    }
    return;
  }

  kv([
    ["ID", session.id],
    ["User", session.user_id ?? "-"],
    ["Status", session.status ?? "-"],
    ["Servers", (session.servers ?? []).join(", ")],
    ["Tool calls", String(session.tool_call_count ?? 0)],
    ["Created", session.created_at ?? "-"],
    ["Closed", session.closed_at ?? "-"],
  ]);

  if (opts.logs) {
    const logs = await client.get<{ data: LogEntry[] }>(`/v1/sessions/${encodeURIComponent(id)}/logs`);
    process.stdout.write("\nLogs:\n");
    table(
      ["TOOL", "SERVER", "STATUS", "MS", "AT"],
      logs.data.map((l) => [
        l.tool,
        l.server,
        l.status,
        String(l.duration_ms ?? "-"),
        l.called_at ? new Date(l.called_at).toISOString().slice(11, 19) : "-",
      ]),
    );
  }
}

export async function closeSessionCommand(client: ApiClient, id: string): Promise<void> {
  if (!id) throw new CliError("Session id is required.");
  await client.post(`/v1/sessions/${encodeURIComponent(id)}/close`);
  success(`Session ${id} closed.`);
}
