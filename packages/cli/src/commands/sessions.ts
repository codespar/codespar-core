import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { isoSeconds, isoTime, json, kv, success, table } from "../output.js";

/** `--limit 20` → 20, refusing anything the query parameter cannot carry. */
function parseLimit(raw: string | undefined, flag = "--limit"): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`${flag} expects a positive whole number, got "${raw}".`);
  }
  return value;
}

type SessionStatus = "active" | "closed" | "error";

const SESSION_STATUSES: readonly SessionStatus[] = ["active", "closed", "error"];

function parseStatus(raw: string | undefined): SessionStatus | undefined {
  if (raw === undefined) return undefined;
  if (!SESSION_STATUSES.includes(raw as SessionStatus)) {
    throw new CliError(`--status expects one of ${SESSION_STATUSES.join(", ")}, got "${raw}".`);
  }
  return raw as SessionStatus;
}

interface ListOptions {
  status?: string;
  limit?: string;
  json?: boolean;
}

export async function listSessionsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get("/v1/sessions", {
    query: { status: parseStatus(opts.status), limit: parseLimit(opts.limit) },
  });

  if (opts.json) {
    json(data.sessions);
    return;
  }

  // No tool-call count here: the listing does not carry one, and the column
  // that used to be in this table printed 0 for every row.
  table(
    ["ID", "USER", "STATUS", "SERVERS", "CREATED"],
    data.sessions.map((s) => [
      s.id,
      s.user_id ?? "-",
      s.status ?? "-",
      (s.servers ?? []).join(", "),
      isoSeconds(s.created_at),
    ]),
  );
  if (data.next_before) {
    process.stdout.write(`\nMore rows: \`--limit\` with a larger number, or page from ${data.next_before}.\n`);
  }
}

interface ShowOptions {
  json?: boolean;
  logs?: boolean;
}

export async function showSessionCommand(
  client: ApiClient,
  id: string,
  opts: ShowOptions,
): Promise<void> {
  if (!id) throw new CliError("Session id is required.");

  const session = await client.get("/v1/sessions/{id}", { path: { id } });

  // `--logs` reads the session's tool calls. It used to read
  // `/v1/sessions/{id}/logs`, a route the API does not have, so the flag
  // 404'd on every session that existed (core#130).
  const calls = opts.logs
    ? (await client.get("/v1/sessions/{id}/tool-calls", { path: { id } })).tool_calls
    : undefined;

  if (opts.json) {
    json(calls ? { session, tool_calls: calls } : session);
    return;
  }

  kv([
    ["ID", session.id],
    ["User", session.user_id ?? "-"],
    ["Status", session.status ?? "-"],
    ["Servers", (session.servers ?? []).join(", ")],
    ["Tool calls", String(session.tool_calls_count ?? 0)],
    ["Created", session.created_at ?? "-"],
    ["Closed", session.closed_at ?? "-"],
  ]);

  if (calls) {
    process.stdout.write("\nTool calls:\n");
    table(
      ["TOOL", "SERVER", "STATUS", "MS", "AT"],
      calls.map((call) => [
        call.tool_name,
        call.server_id ?? "-",
        call.status ?? "-",
        String(call.duration_ms ?? "-"),
        isoTime(call.called_at),
      ]),
    );
  }
}

export async function closeSessionCommand(client: ApiClient, id: string): Promise<void> {
  if (!id) throw new CliError("Session id is required.");
  // `DELETE /v1/sessions/{id}` is the documented close. The old
  // `POST /v1/sessions/{id}/close` was never a route (core#130).
  const closed = await client.delete("/v1/sessions/{id}", { path: { id } });
  success(`Session ${closed.id} ${closed.status}${closed.closed_at ? ` at ${closed.closed_at}` : ""}.`);
}
