import { describe, it, expect, vi } from "vitest";
import { getMcpConfig, getClaudeDesktopConfig, getCursorConfig } from "../index.js";
import type { Session } from "@codespar/core";

/* ── Fixtures ── */

function mockSession(): Session {
  return {
    id: "sess_abc",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    mcp: {
      url: "https://mcp.codespar.dev/sess_abc",
      headers: { Authorization: "Bearer tok_123" },
    },
    tools: () => [],
    findTools: vi.fn(),
    execute: vi.fn(),
    loop: vi.fn(),
    send: vi.fn(),
    authorize: vi.fn(),
    connections: vi.fn(),
    close: vi.fn(),
  };
}

/* ── Tests ── */

describe("getMcpConfig", () => {
  it("returns url and headers from session", () => {
    const config = getMcpConfig(mockSession());

    expect(config.url).toBe("https://mcp.codespar.dev/sess_abc");
    expect(config.headers).toEqual({ Authorization: "Bearer tok_123" });
  });
});

describe("getClaudeDesktopConfig", () => {
  it("returns valid config structure with default server name", () => {
    const config = getClaudeDesktopConfig(mockSession());

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.codespar).toBeDefined();
    expect(config.mcpServers.codespar.command).toBe("npx");
    expect(config.mcpServers.codespar.args).toContain("@codespar/mcp");
    expect(config.mcpServers.codespar.args).toContain("--session");
    expect(config.mcpServers.codespar.args).toContain("sess_abc");
  });

  it("accepts custom server name", () => {
    const config = getClaudeDesktopConfig(mockSession(), "my-server");

    expect(config.mcpServers["my-server"]).toBeDefined();
    expect(config.mcpServers["codespar"]).toBeUndefined();
  });

  it("includes MCP_URL in env", () => {
    const config = getClaudeDesktopConfig(mockSession());
    expect(config.mcpServers.codespar.env?.MCP_URL).toBe("https://mcp.codespar.dev/sess_abc");
  });

  it("includes session headers in env", () => {
    const config = getClaudeDesktopConfig(mockSession());
    expect(config.mcpServers.codespar.env?.Authorization).toBe("Bearer tok_123");
  });
});

describe("getCursorConfig", () => {
  it("returns url and headers", () => {
    const config = getCursorConfig(mockSession());

    expect(config.url).toBe("https://mcp.codespar.dev/sess_abc");
    expect(config.headers).toEqual({ Authorization: "Bearer tok_123" });
  });
});
