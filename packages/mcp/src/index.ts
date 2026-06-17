/**
 * @codespar/mcp — MCP transport config helper
 *
 * Generates Model Context Protocol configuration files for connecting
 * external MCP clients (Claude Desktop, Cursor, VS Code) to a CodeSpar
 * session.
 *
 * `getClaudeDesktopConfig` emits a stdio launch (`npx -y @codespar/mcp serve`)
 * with `CODESPAR_API_KEY` in env — the exact shape the bin reads, and the same
 * one shown on https://codespar.dev/agents. `getCursorConfig`/`getMcpConfig`
 * return the remote `{ url, headers }` transport (the session's hosted MCP
 * endpoint) for clients that connect over HTTP instead of stdio.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getClaudeDesktopConfig, getCursorConfig } from "@codespar/mcp";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["zoop"] });
 *
 * const claudeDesktop = getClaudeDesktopConfig(session);
 * // → drop into ~/Library/Application Support/Claude/claude_desktop_config.json
 * ```
 */

import type { Session } from "@codespar/sdk";

export interface McpConfig {
  url: string;
  headers: Record<string, string>;
}

export interface ClaudeDesktopServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Get the MCP transport URL and headers for a session.
 * Works with any MCP-compatible client.
 */
export function getMcpConfig(session: Session): McpConfig {
  if (!session.mcp) throw new Error("Session does not have an MCP transport configured.");
  return {
    url: session.mcp.url,
    headers: session.mcp.headers,
  };
}

/**
 * Generate Claude Desktop configuration for a CodeSpar session.
 *
 * Output goes in:
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json
 */
export function getClaudeDesktopConfig(
  session: Session,
  serverName = "codespar",
): { mcpServers: Record<string, ClaudeDesktopServerConfig> } {
  if (!session.mcp) throw new Error("Session does not have an MCP transport configured.");
  // The stdio bin reads CODESPAR_API_KEY from env (not the MCP URL or an auth
  // header). Derive it from the session's bearer so the emitted config boots
  // as-is. `--session` is not a bin flag — the canonical command is `serve`.
  const apiKey = (session.mcp.headers["Authorization"] ?? "").replace(/^Bearer\s+/i, "");
  const project = session.mcp.headers["x-codespar-project"];
  return {
    mcpServers: {
      [serverName]: {
        command: "npx",
        args: ["-y", "@codespar/mcp", "serve"],
        env: {
          CODESPAR_API_KEY: apiKey,
          ...(project ? { CODESPAR_PROJECT: project } : {}),
        },
      },
    },
  };
}

/**
 * Generate Cursor / VS Code MCP configuration.
 * Both tools accept the same `{ url, headers }` shape.
 */
export function getCursorConfig(session: Session): McpConfig {
  return getMcpConfig(session);
}
