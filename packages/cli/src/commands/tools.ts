import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, kv, table } from "../output.js";

interface ToolSummary {
  name: string;
  server: string;
  description?: string;
}

interface ToolDetail extends ToolSummary {
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

interface ListOptions {
  server?: string;
  json?: boolean;
}

export async function listToolsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get<{ data: ToolSummary[] }>("/v1/tools", {
    server: opts.server,
  });

  if (opts.json) {
    json(data.data);
    return;
  }

  table(
    ["NAME", "SERVER", "DESCRIPTION"],
    data.data.map((t) => [
      t.name,
      t.server,
      truncate(t.description ?? "", 60),
    ]),
  );
}

interface ShowOptions {
  json?: boolean;
}

export async function showToolCommand(
  client: ApiClient,
  name: string,
  opts: ShowOptions,
): Promise<void> {
  if (!name) throw new CliError("Tool name is required. Example: `codespar tools show codespar_pay`");

  const tool = await client.get<ToolDetail>(`/v1/tools/${encodeURIComponent(name)}`);

  if (opts.json) {
    json(tool);
    return;
  }

  kv([
    ["Name", tool.name],
    ["Server", tool.server],
  ]);
  if (tool.description) process.stdout.write(`\n${tool.description}\n`);

  if (tool.input_schema) {
    process.stdout.write("\nInput schema:\n");
    process.stdout.write(JSON.stringify(tool.input_schema, null, 2) + "\n");
  }
  if (tool.output_schema) {
    process.stdout.write("\nOutput schema:\n");
    process.stdout.write(JSON.stringify(tool.output_schema, null, 2) + "\n");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
