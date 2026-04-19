import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, success, table } from "../output.js";

const execAsync = promisify(exec);

interface Connection {
  id: string;
  server_id: string;
  user_id: string;
  auth_type: string;
  status: "connected" | "pending" | "revoked" | "expired";
  display_name: string | null;
  connected_at: string | null;
  expires_at: string | null;
}

interface StartResponse {
  link_token: string;
  authorize_url: string;
  expires_at: string;
}

interface ListOptions {
  user?: string;
  status?: string;
  json?: boolean;
}

export async function listConnectionsCommand(client: ApiClient, opts: ListOptions): Promise<void> {
  const data = await client.get<{ connections: Connection[] }>("/v1/connections", {
    user_id: opts.user,
    status: opts.status,
  });

  if (opts.json) {
    json(data.connections);
    return;
  }

  table(
    ["ID", "SERVER", "USER", "STATUS", "CONNECTED", "EXPIRES"],
    data.connections.map((c) => [
      c.id,
      c.server_id,
      c.user_id,
      c.status,
      c.connected_at ? new Date(c.connected_at).toISOString().slice(0, 10) : "-",
      c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : "-",
    ]),
  );
}

interface StartOptions {
  user?: string;
  redirectUri?: string;
  scopes?: string;
  open?: boolean;
  json?: boolean;
}

/**
 * Start a Connect Link OAuth flow for a server. Prints the authorize URL
 * so the user can click or share it; optionally opens it in the default
 * browser. This is the CLI equivalent of `session.authorize(serverId, {...})`.
 */
export async function startConnectCommand(
  client: ApiClient,
  server: string,
  opts: StartOptions,
): Promise<void> {
  if (!server) throw new CliError("Server id is required. Example: `codespar connect start stripe`");

  const userId = opts.user ?? "cli-user";
  // Default to a localhost landing so the CLI works end-to-end without
  // a hosted UI. Users with a real app should pass --redirect-uri.
  const redirectUri = opts.redirectUri ?? "http://localhost:3000/connect/success";

  const res = await client.post<StartResponse>("/v1/connect/start", {
    server_id: server,
    user_id: userId,
    redirect_uri: redirectUri,
    scopes: opts.scopes,
  });

  if (opts.json) {
    json(res);
    return;
  }

  info(`Connect ${server} for user ${userId}:`);
  process.stdout.write(`\n  ${res.authorize_url}\n\n`);
  info(`Link expires ${new Date(res.expires_at).toLocaleString()}`);

  if (opts.open) {
    await openInBrowser(res.authorize_url).catch(() => {
      // Silent fail — user can copy/paste from stdout.
    });
  } else {
    info("Tip: pass --open to launch the link in your browser automatically.");
  }
}

interface RevokeOptions {
  user?: string;
  id?: string;
}

/**
 * Revoke a connection. Requires the connection id (ca_<nanoid>). If the
 * user doesn't know the id, `codespar connect list` shows them — revoke
 * by (server, user) would require a DB lookup the backend doesn't expose
 * as a shortcut.
 */
export async function revokeConnectCommand(
  client: ApiClient,
  serverOrId: string,
  opts: RevokeOptions,
): Promise<void> {
  if (!serverOrId) throw new CliError("Connection id is required. Example: `codespar connect revoke ca_abc123`");

  // If the argument looks like a connection id (ca_...), revoke directly.
  // Otherwise treat it as a server_id and look up the active connection
  // for the given user so the CLI keeps the old "revoke stripe" ergonomics.
  let connectionId = serverOrId;
  if (!serverOrId.startsWith("ca_")) {
    const userId = opts.user ?? "cli-user";
    const list = await client.get<{ connections: Connection[] }>("/v1/connections", {
      user_id: userId,
      server_id: serverOrId,
      status: "connected",
    });
    if (list.connections.length === 0) {
      throw new CliError(`No active connection for server "${serverOrId}" and user "${userId}".`);
    }
    connectionId = list.connections[0]!.id;
  }

  await client.post(`/v1/connections/${encodeURIComponent(connectionId)}/revoke`, {});
  success(`Revoked connection ${connectionId}.`);
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
