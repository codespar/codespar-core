import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, kv, table } from "../output.js";

interface ListOptions {
  category?: string;
  country?: string;
  q?: string;
  json?: boolean;
}

export async function listServersCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get("/v1/servers", {
    query: { category: opts.category, country: opts.country, q: opts.q },
  });

  if (opts.json) {
    json(data.servers);
    return;
  }

  table(
    ["ID", "NAME", "CATEGORY", "COUNTRY", "TOOLS", "STATUS"],
    data.servers.map((s) => [
      s.id,
      s.name,
      s.category ?? "-",
      s.country ?? "-",
      String(s.tools_count ?? "-"),
      s.status ?? "-",
    ]),
  );
  if (data.filtered !== data.total) {
    process.stdout.write(`\n${data.filtered} of ${data.total} servers shown.\n`);
  }
}

interface ShowOptions {
  json?: boolean;
}

/**
 * One server, assembled from the three routes that describe it.
 *
 * There is no `GET /v1/servers/{id}`: this command used to call it and got
 * a 404 every time it ran (core#130). What exists is the catalog listing,
 * which carries the descriptive fields, plus the two per-server reads. The
 * listing is fetched first because it is the only one that can tell an
 * unknown id from an id whose tools have not been indexed.
 */
export async function showServerCommand(
  client: ApiClient,
  id: string,
  opts: ShowOptions,
): Promise<void> {
  if (!id) throw new CliError("Server id is required. Example: `codespar servers show stripe`");

  const catalog = await client.get("/v1/servers");
  const server = catalog.servers.find((s) => s.id === id);
  if (!server) {
    throw new CliError(
      `No server with id "${id}" in the catalog. Run \`codespar servers list\` to see the ${catalog.total} available.`,
    );
  }

  const [tools, auth] = await Promise.all([
    client.get("/v1/servers/{id}/tools", { path: { id } }),
    client.get("/v1/servers/{id}/auth-schema", { path: { id } }),
  ]);

  if (opts.json) {
    json({ ...server, auth_schema: auth, tools: tools.tools });
    return;
  }

  kv([
    ["ID", server.id],
    ["Name", server.name],
    ["Category", server.category ?? "-"],
    ["Country", server.country ?? "-"],
    ["Status", server.status ?? "-"],
    ["Auth", auth.auth_type],
    ["Environment", auth.environment],
    ["Tools", String(tools.total)],
  ]);

  if (server.description) {
    process.stdout.write(`\n${server.description}\n`);
  }

  if (auth.fields.length > 0) {
    process.stdout.write("\nCredentials it asks for:\n");
    for (const field of auth.fields) {
      process.stdout.write(`  • ${field.label} (${field.name}, ${field.kind})\n`);
    }
  }

  if (tools.tools.length > 0) {
    process.stdout.write("\nTools:\n");
    for (const tool of tools.tools) {
      process.stdout.write(`  • ${tool.name}${tool.description ? ` — ${tool.description}` : ""}\n`);
    }
  }
}
