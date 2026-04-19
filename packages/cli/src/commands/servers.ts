import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, kv, table } from "../output.js";

interface ServerSummary {
  id: string;
  name: string;
  category?: string;
  region?: string;
  status?: "live" | "beta" | "coming-soon";
  tool_count?: number;
  capabilities?: string[];
}

interface ServerDetail extends ServerSummary {
  description?: string;
  auth_type?: string;
  docs_url?: string;
  tools?: Array<{ name: string; description?: string }>;
}

interface ListOptions {
  category?: string;
  region?: string;
  json?: boolean;
}

export async function listServersCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get<{ data: ServerSummary[] }>("/v1/servers", {
    category: opts.category,
    region: opts.region,
  });

  if (opts.json) {
    json(data.data);
    return;
  }

  table(
    ["ID", "NAME", "CATEGORY", "REGION", "TOOLS", "STATUS"],
    data.data.map((s) => [
      s.id,
      s.name,
      s.category ?? "-",
      s.region ?? "-",
      String(s.tool_count ?? "-"),
      s.status ?? "-",
    ]),
  );
}

interface ShowOptions {
  json?: boolean;
}

export async function showServerCommand(
  client: ApiClient,
  id: string,
  opts: ShowOptions,
): Promise<void> {
  if (!id) throw new CliError("Server id is required. Example: `codespar servers show stripe`");

  const server = await client.get<ServerDetail>(`/v1/servers/${encodeURIComponent(id)}`);

  if (opts.json) {
    json(server);
    return;
  }

  kv([
    ["ID", server.id],
    ["Name", server.name],
    ["Category", server.category ?? "-"],
    ["Region", server.region ?? "-"],
    ["Status", server.status ?? "-"],
    ["Auth", server.auth_type ?? "-"],
    ["Tools", String(server.tool_count ?? server.tools?.length ?? "-")],
  ]);

  if (server.description) {
    process.stdout.write(`\n${server.description}\n`);
  }

  if (server.tools && server.tools.length > 0) {
    process.stdout.write("\nTools:\n");
    for (const t of server.tools) {
      process.stdout.write(`  • ${t.name}${t.description ? ` — ${t.description}` : ""}\n`);
    }
  }
}
