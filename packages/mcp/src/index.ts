/**
 * @codespar/mcp — MCP transport config helper
 *
 * Generates Model Context Protocol configuration files for connecting
 * external MCP clients (Claude Desktop, Cursor, VS Code) to a CodeSpar
 * session.
 *
 * **Status (0.2.0):** Config files are generated correctly. The runtime
 * MCP endpoint on the backend is planned for Marco 3 — until then, the
 * generated configs reference an endpoint that returns 404. This package
 * is shipped now so devs can wire their tooling and have it work the
 * moment the backend MCP transport ships.
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
  return {
    mcpServers: {
      [serverName]: {
        command: "npx",
        args: ["-y", "@codespar/mcp", "--session", session.id],
        env: {
          MCP_URL: session.mcp.url,
          ...session.mcp.headers,
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
