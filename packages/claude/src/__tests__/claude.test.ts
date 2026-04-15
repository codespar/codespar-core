import { describe, it, expect, vi } from "vitest";
import { getTools, toClaudeTool, getToolDefinitions } from "../index.js";
import type { Session, Tool, ToolResult } from "@codespar/sdk";

/* ── Fixtures ── */

function mockTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "ZOOP_CREATE_CHARGE",
    slug: "zoop_create_charge",
    description: "Create a Pix charge",
    server: "zoop",
    inputSchema: { type: "object", properties: { amount: { type: "number" } } },
    ...overrides,
  };
}

function mockSession(tools: Tool[] = [mockTool()]): Session {
  return {
    id: "sess_1",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    mcp: { url: "https://mcp.test", headers: {} },
    tools: () => tools,
    findTools: vi.fn(),
    execute: vi.fn().mockResolvedValue({
      success: true,
      data: { id: "ch_1" },
      duration: 42,
      server: "zoop",
      tool: "ZOOP_CREATE_CHARGE",
    } as ToolResult),
    loop: vi.fn(),
    send: vi.fn(),
    authorize: vi.fn(),
    connections: vi.fn(),
    close: vi.fn(),
  };
}

/* ── Tests ── */

describe("getTools", () => {
  it("returns array of ClaudeToolWithExecute", () => {
    const session = mockSession([mockTool(), mockTool({ slug: "nfe_issue", name: "NFE_ISSUE" })]);
    const tools = getTools(session);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual(
      expect.objectContaining({
        name: "zoop_create_charge",
        description: "Create a Pix charge",
        input_schema: expect.any(Object),
      })
    );
    expect(typeof tools[0].execute).toBe("function");
  });

  it("execute delegates to session.execute", async () => {
    const session = mockSession();
    const tools = getTools(session);
    const result = await tools[0].execute({ amount: 150 });

    expect(session.execute).toHaveBeenCalledWith("ZOOP_CREATE_CHARGE", { amount: 150 });
    expect(result).toEqual({ id: "ch_1" });
  });

  it("execute throws on failure", async () => {
    const session = mockSession();
    (session.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false, data: null, error: "Fail", duration: 5, server: "zoop", tool: "ZOOP_CREATE_CHARGE",
    });

    const tools = getTools(session);
    await expect(tools[0].execute({})).rejects.toThrow("Fail");
  });
});

describe("toClaudeTool", () => {
  it("produces correct structure", () => {
    const tool = mockTool();
    const session = mockSession();
    const claude = toClaudeTool(tool, session);

    expect(claude.name).toBe("zoop_create_charge");
    expect(claude.description).toBe("Create a Pix charge");
    expect(claude.input_schema).toEqual(tool.inputSchema);
    expect(typeof claude.execute).toBe("function");
  });
});

describe("getToolDefinitions", () => {
  it("returns plain ClaudeTool without execute", () => {
    const session = mockSession([mockTool(), mockTool({ slug: "nfe_issue", name: "NFE_ISSUE" })]);
    const defs = getToolDefinitions(session);

    expect(defs).toHaveLength(2);
    expect(defs[0]).toEqual({
      name: "zoop_create_charge",
      description: "Create a Pix charge",
      input_schema: expect.any(Object),
    });
    // Should NOT have execute
    expect((defs[0] as any).execute).toBeUndefined();
  });
});
