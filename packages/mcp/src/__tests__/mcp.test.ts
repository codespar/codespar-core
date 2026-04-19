/**
 * @codespar/mcp basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, ToolResult } from "@codespar/sdk";
import { getMcpConfig, getClaudeDesktopConfig, getCursorConfig } from "../index.js";

function fakeSession(): Session {
  return {
    id: "ses_demo",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    status: "active",
    mcp: {
      url: "https://api.codespar.dev/v1/sessions/ses_demo/mcp",
      headers: { Authorization: "Bearer csk_live_x" },
    },
    async tools() {
      return [];
    },
    async findTools() {
      return [];
    },
    async execute(toolName: string): Promise<ToolResult> {
      return { success: true, data: null, error: null, duration: 0, server: "", tool: toolName };
    },
    async loop() {
      return { success: true, results: [], duration: 0, completedSteps: 0, totalSteps: 0 };
    },
    async proxyExecute() {
      return { status: 200, data: null, headers: {}, duration: 0 };
    },
    async send() {
      return { message: "", tool_calls: [], iterations: 0 };
    },
    async *sendStream() {
      // empty
    },
    async authorize() {
      return { connected: false };
    },
    async connections() {
      return [];
    },
    async close() {
      // noop
    },
  };
}

describe("@codespar/mcp", () => {
  it("getMcpConfig surfaces session.mcp", () => {
    const session = fakeSession();
    const cfg = getMcpConfig(session);
    expect(cfg.url).toBe("https://api.codespar.dev/v1/sessions/ses_demo/mcp");
    expect(cfg.headers.Authorization).toBe("Bearer csk_live_x");
  });

  it("getClaudeDesktopConfig wraps in mcpServers shape", () => {
    const session = fakeSession();
    const cfg = getClaudeDesktopConfig(session);
    expect(cfg.mcpServers.codespar).toBeDefined();
    expect(cfg.mcpServers.codespar!.command).toBe("npx");
    expect(cfg.mcpServers.codespar!.args).toContain("ses_demo");
    expect(cfg.mcpServers.codespar!.env?.MCP_URL).toBe(session.mcp.url);
  });

  it("getClaudeDesktopConfig accepts custom server name", () => {
    const session = fakeSession();
    const cfg = getClaudeDesktopConfig(session, "myorg");
    expect(cfg.mcpServers.myorg).toBeDefined();
  });

  it("getCursorConfig matches getMcpConfig", () => {
    const session = fakeSession();
    expect(getCursorConfig(session)).toEqual(getMcpConfig(session));
  });
});
