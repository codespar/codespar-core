import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, success, table } from "../output.js";

const execAsync = promisify(exec);

interface Connection {
  server: string;
  user_id?: string;
  status: "connected" | "pending" | "revoked" | "expired";
  connected_at?: string;
  expires_at?: string;
}

interface StartResponse {
  connect_url: string;
  connection_id: string;
  expires_at?: string;
}

interface ListOptions {
  user?: string;
  status?: string;
  json?: boolean;
}

export async function listConnectionsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get<{ data: Connection[] }>("/v1/connections", {
    user: opts.user,
    status: opts.status,
  });

  if (opts.json) {
    json(data.data);
    return;
  }

  table(
    ["SERVER", "USER", "STATUS", "CONNECTED", "EXPIRES"],
    data.data.map((c) => [
      c.server,
      c.user_id ?? "-",
      c.status,
      c.connected_at ? new Date(c.connected_at).toISOString().slice(0, 10) : "-",
      c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : "-",
    ]),
  );
}

interface StartOptions {
  user?: string;
  open?: boolean;
  json?: boolean;
}

/**
 * Start a Connect Link flow for a server. Prints the authorization URL so
 * the user can click or share it; optionally opens it in the default browser.
 * This is the CLI equivalent of `session.authorize(serverId)`.
 */
export async function startConnectCommand(
  client: ApiClient,
  server: string,
  opts: StartOptions,
): Promise<void> {
  if (!server) throw new CliError("Server id is required. Example: `codespar connect start stripe`");

  const userId = opts.user ?? "cli-user";
  const res = await client.post<StartResponse>("/v1/connections", { server, user_id: userId });

  if (opts.json) {
    json(res);
    return;
  }

  info(`Connect ${server} for user ${userId}:`);
  process.stdout.write(`\n  ${res.connect_url}\n\n`);
  if (res.expires_at) {
    info(`Link expires ${new Date(res.expires_at).toLocaleString()}`);
  }

  if (opts.open) {
    await openInBrowser(res.connect_url).catch(() => {
      // Silent fail — user can copy/paste from stdout.
    });
  } else {
    info("Tip: pass --open to launch the link in your browser automatically.");
  }
}

interface RevokeOptions {
  user?: string;
}

export async function revokeConnectCommand(
  client: ApiClient,
  server: string,
  opts: RevokeOptions,
): Promise<void> {
  if (!server) throw new CliError("Server id is required. Example: `codespar connect revoke stripe`");
  const userId = opts.user ?? "cli-user";
  await client.delete(`/v1/connections/${encodeURIComponent(server)}?user=${encodeURIComponent(userId)}`);
  success(`Revoked ${server} for user ${userId}.`);
}

/**
 * Opens a URL in the system's default browser. Uses `open` on macOS,
 * `xdg-open` on Linux, `start` on Windows. Intentionally minimal — we
 * don't bring in `open`/`openurl` npm packages just for this.
 */
async function openInBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === "darwin"
      ? `open ${JSON.stringify(url)}`
      : process.platform === "win32"
        ? `start "" ${JSON.stringify(url)}`
        : `xdg-open ${JSON.stringify(url)}`;
  await execAsync(cmd);
}
