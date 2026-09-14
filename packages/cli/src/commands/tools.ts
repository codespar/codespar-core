import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, kv, table } from "../output.js";

/**
 * Tools are listed per server, because that is the only listing the API has.
 *
 * These two commands used to call `GET /v1/tools` and `GET /v1/tools/{name}`,
 * a pair of routes that has never existed: both 404'd on every invocation
 * (core#130). What exists is `GET /v1/servers/{id}/tools`, so the server is
 * no longer an optional filter — it is the address of the listing.
 */
function requireServer(server: string | undefined, example: string): string {
  if (server) return server;
  throw new CliError(
    [
      "A server is required: tools are listed per server.",
      "",
      `  ${example}`,
      "",
      "  codespar servers list          the ids you can pass",
      "  codespar tools meta            the 15 meta-tools, which are not per-server",
    ].join("\n"),
  );
}

interface ListOptions {
  server?: string;
  json?: boolean;
}

export async function listToolsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const id = requireServer(opts.server, "codespar tools list --server stripe");
  const data = await client.get("/v1/servers/{id}/tools", { path: { id } });

  if (opts.json) {
    json(data.tools);
    return;
  }

  table(
    ["NAME", "DESCRIPTION"],
    data.tools.map((tool) => [tool.name, truncate(tool.description ?? "", 70)]),
  );
  process.stdout.write(`\n${data.total} tool(s) on ${data.server_id}.\n`);
}

interface ShowOptions {
  server?: string;
  json?: boolean;
}

export async function showToolCommand(
  client: ApiClient,
  name: string,
  opts: ShowOptions,
): Promise<void> {
  if (!name) {
    throw new CliError("Tool name is required. Example: `codespar tools show accept_dispute --server adyen`");
  }
  const id = requireServer(opts.server, `codespar tools show ${name} --server adyen`);

  const data = await client.get("/v1/servers/{id}/tools", { path: { id } });
  const tool = data.tools.find((t) => t.name === name);
  if (!tool) {
    throw new CliError(
      `${id} exposes no tool called "${name}". Run \`codespar tools list --server ${id}\` for the ${data.total} it does expose.`,
    );
  }

  if (opts.json) {
    json(tool);
    return;
  }

  kv([
    ["Name", tool.name],
    ["Server", data.server_id],
  ]);
  if (tool.description) process.stdout.write(`\n${tool.description}\n`);
  // No input/output schema section: the catalog listing carries a name and a
  // description, and nothing else. It is `codespar tools meta <name>` that
  // has schemas, for the meta-tools, from the published definitions.
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
