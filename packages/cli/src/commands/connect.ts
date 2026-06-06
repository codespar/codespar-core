import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, success, table } from "../output.js";

const execFileAsync = promisify(execFile);

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

  // Auto-open when we're in an interactive terminal — matches what devs
  // expect from `gh auth login` / `vercel login` / etc. In CI or piped
  // runs stdout is not a TTY, so we skip and let the caller grab the
  // URL from the printed output. `--no-open` also skips explicitly.
  const shouldOpen =
    opts.open !== false && Boolean(process.stdout.isTTY);

  if (shouldOpen) {
    await openInBrowser(res.authorize_url).catch(() => {
      // Silent fail — user can copy/paste from stdout.
    });
    info("Opened in your default browser. If nothing appeared, copy the URL above.");
  } else if (!opts.open) {
    info("Tip: pass --open on a future run to launch the link automatically.");
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
/**
 * Parse + validate that `url` is a real http(s) URL before handing it to the
 * OS browser-opener. Rejects malformed URLs and non-http(s) schemes
 * (file://, javascript:, ...). Exported for testing.
 */
export function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`Refusing to open a malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CliError(`Refusing to open a non-http(s) URL (${parsed.protocol}).`);
  }
  return parsed;
}

async function openInBrowser(url: string): Promise<void> {
  // Pass the URL as a literal argv (execFile, no shell) so a Connect Link
  // carrying shell metacharacters — `$(...)`, backticks — can't inject a
  // command. Double-quoting it under exec() did NOT prevent that ($ and
  // backticks are still live inside double quotes).
  const parsed = assertHttpUrl(url);
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [parsed.href]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", parsed.href]]
        : ["xdg-open", [parsed.href]];
  await execFileAsync(cmd, args);
}
