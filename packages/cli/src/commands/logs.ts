import { CliError, type CliConfig } from "../config.js";
import { c, json } from "../output.js";

interface LogEntry {
  id: string;
  tool: string;
  server: string;
  status: "success" | "error" | "running";
  duration_ms?: number;
  called_at?: string;
  session_id?: string;
  error?: string;
}

interface TailOptions {
  server?: string;
  status?: string;
  tool?: string;
  limit?: string;
  json?: boolean;
}

/**
 * Stream execution logs live from /v1/logs/stream (SSE).
 * Falls through on Ctrl-C — we don't need a clean shutdown, the server
 * will close the connection when stdin closes.
 */
export async function tailLogsCommand(
  config: Required<Pick<CliConfig, "apiKey" | "baseUrl">>,
  opts: TailOptions,
): Promise<void> {
  const url = new URL("/v1/logs/stream", config.baseUrl);
  if (opts.server) url.searchParams.set("server", opts.server);
  if (opts.status) url.searchParams.set("status", opts.status);
  if (opts.tool) url.searchParams.set("tool", opts.tool);
  if (opts.limit) url.searchParams.set("limit", opts.limit);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "text/event-stream",
      },
    });
  } catch (err) {
    throw new CliError(`Failed to connect: ${(err as Error).message}`);
  }

  if (!res.ok || !res.body) {
    throw new CliError(`Log stream returned ${res.status}. Check your API key.`);
  }

  process.stderr.write(c.dim("Tailing logs — press Ctrl-C to stop\n\n"));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line (\n\n).
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
      if (dataLines.length === 0) continue;

      try {
        const entry = JSON.parse(dataLines.join("\n")) as LogEntry;
        printEntry(entry, opts.json ?? false);
      } catch {
        // Ignore malformed frames (keep-alives, comments)
      }
    }
  }
}

function printEntry(entry: LogEntry, asJson: boolean): void {
  if (asJson) {
    json(entry);
    return;
  }

  const time = entry.called_at ? new Date(entry.called_at).toISOString().slice(11, 19) : "--:--:--";
  const statusColor =
    entry.status === "success" ? c.green : entry.status === "error" ? c.red : c.yellow;
  const statusLabel = statusColor(entry.status.toUpperCase().padEnd(7));

  const durationStr = entry.duration_ms !== undefined ? `${entry.duration_ms}ms` : "";
  const suffix = entry.error ? ` ${c.red(entry.error)}` : "";

  process.stdout.write(
    `${c.gray(time)}  ${statusLabel}  ${entry.tool.padEnd(24)}  ${c.dim(entry.server.padEnd(16))}  ${c.dim(durationStr)}${suffix}\n`,
  );
}
