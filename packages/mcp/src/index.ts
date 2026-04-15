/**
 * @codespar/mcp — MCP transport for IDE integration
 *
 * Provides MCP server URLs and config for connecting
 * Claude Desktop, Cursor, VS Code, and other MCP clients
 * to a CodeSpar session.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getMcpConfig, getClaudeDesktopConfig } from "@codespar/mcp";
 *
 * const cs = new CodeSpar({ apiKey: "ak_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 *
 * // Get MCP URL and headers for any client
 * const { url, headers } = getMcpConfig(session);
 *
 * // Get Claude Desktop config JSON
 * const config = getClaudeDesktopConfig(session);
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
  return {
    url: session.mcp.url,
    headers: session.mcp.headers,
  };
}

/**
 * Generate Claude Desktop configuration for a CodeSpar session.
 * Output goes in ~/Library/Application Support/Claude/claude_desktop_config.json
 */
export function getClaudeDesktopConfig(
  session: Session,
  serverName = "codespar"
): { mcpServers: Record<string, ClaudeDesktopServerConfig> } {
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
 */
export function getCursorConfig(session: Session): { url: string; headers: Record<string, string> } {
  return {
    url: session.mcp.url,
    headers: session.mcp.headers,
  };
}
