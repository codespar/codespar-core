import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { c, isoTime, jsonLine } from "../output.js";

/**
 * The project's tool-call log.
 *
 * This command used to open an SSE stream on `GET /v1/logs/stream`. That
 * route has never existed, so every run ended in the "planned endpoint"
 * message the old code printed on 404 — and that message sent the reader to
 * `sessions show <id> --logs`, which called a second route that does not
 * exist either (core#130).
 *
 * What exists is `GET /v1/tool-calls`, a page of rows newest-first with a
 * `since` cursor. So `--follow` polls it rather than holding a stream open:
 * the API has no push channel for this, and a poll that says it is a poll
 * beats a stream that is not one.
 */

interface ToolCallRow {
  id: string;
  tool_name: string;
  server_id?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  error_code?: string | null;
  called_at?: string | null;
  session_id?: string | null;
}

export interface TailOptions {
  server?: string;
  status?: string;
  tool?: string;
  limit?: string;
  follow?: boolean;
  intervalMs?: number;
  json?: boolean;
}

/** The filters the API cannot apply. Kept client-side, and counted out loud. */
export function applyFilters(rows: readonly ToolCallRow[], opts: TailOptions): ToolCallRow[] {
  return rows.filter(
    (row) =>
      (!opts.server || row.server_id === opts.server) &&
      (!opts.status || row.status === opts.status) &&
      (!opts.tool || row.tool_name === opts.tool),
  );
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`--limit expects a positive whole number, got "${raw}".`);
  }
  return value;
}

export async function tailLogsCommand(client: ApiClient, opts: TailOptions): Promise<void> {
  const limit = parseLimit(opts.limit);
  const filtered = Boolean(opts.server || opts.status || opts.tool);

  const page = await fetchPage(client, { limit });
  const rows = [...page].reverse(); // newest-first from the API; read oldest-first
  const shown = applyFilters(rows, opts);

  for (const row of shown) printRow(row, opts.json ?? false);

  if (!opts.json && filtered) {
    // The API takes no server/status/tool filter, so these are applied to the
    // page that was fetched. Saying which page keeps "no matches" from
    // reading as "nothing happened".
    process.stderr.write(
      c.dim(`\n${shown.length} of the ${rows.length} most recent tool calls match the filters.\n`),
    );
  }

  if (!opts.follow) return;

  const interval = opts.intervalMs ?? 3000;
  const seen = new Set(rows.map((row) => row.id));
  let since = newestTimestamp(rows);

  if (!opts.json) {
    process.stderr.write(
      c.dim(`\nPolling every ${Math.round(interval / 1000)}s — press Ctrl-C to stop\n\n`),
    );
  }

  for (;;) {
    await sleep(interval);
    const next = await fetchPage(client, { limit, since });
    // `since` is inclusive, so the row it names comes back on every poll.
    const fresh = [...next].reverse().filter((row) => !seen.has(row.id));
    for (const row of applyFilters(fresh, opts)) printRow(row, opts.json ?? false);
    for (const row of fresh) seen.add(row.id);
    since = newestTimestamp(fresh) ?? since;
  }
}

function newestTimestamp(rows: readonly ToolCallRow[]): string | undefined {
  let newest: string | undefined;
  for (const row of rows) {
    if (row.called_at && (newest === undefined || row.called_at > newest)) newest = row.called_at;
  }
  return newest;
}

async function fetchPage(
  client: ApiClient,
  query: { limit: number; since?: string },
): Promise<ToolCallRow[]> {
  const data = await client.get("/v1/tool-calls", { query });
  // The operation also answers `{ total }` when called with count_only; this
  // command never asks for that, and the narrowing says so rather than
  // assuming it.
  if (!("tool_calls" in data)) return [];
  return data.tool_calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printRow(row: ToolCallRow, asJson: boolean): void {
  if (asJson) {
    // NDJSON: um objeto por linha. Com `json()` cada linha saia indentada em
    // varias, e o fluxo inteiro deixava de ser parseavel de uma vez.
    jsonLine(row);
    return;
  }

  const time = isoTime(row.called_at);
  const status = row.status ?? "unknown";
  const colour = status === "success" ? c.green : status === "error" ? c.red : c.yellow;
  const duration = row.duration_ms !== undefined && row.duration_ms !== null ? `${row.duration_ms}ms` : "";
  const suffix = row.error_code ? ` ${c.red(row.error_code)}` : "";

  process.stdout.write(
    `${c.gray(time)}  ${colour(status.toUpperCase().padEnd(7))}  ${row.tool_name.padEnd(24)}  ${c.dim((row.server_id ?? "-").padEnd(16))}  ${c.dim(duration)}${suffix}\n`,
  );
}
