import { describe, it, expect, vi } from "vitest";
import { getTools, toOpenAITool, handleToolCall } from "../index.js";
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
  it("returns OpenAI function format", () => {
    const session = mockSession([mockTool(), mockTool({ slug: "nfe_issue", name: "NFE_ISSUE", description: "Issue NF-e" })]);
    const tools = getTools(session);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: "zoop_create_charge",
        description: "Create a Pix charge",
        parameters: expect.any(Object),
      },
    });
  });

  it("returns empty array when no tools", () => {
    const session = mockSession([]);
    expect(getTools(session)).toEqual([]);
  });
});

describe("toOpenAITool", () => {
  it("wraps in type: function", () => {
    const tool = mockTool();
    const openai = toOpenAITool(tool);

    expect(openai.type).toBe("function");
    expect(openai.function.name).toBe("zoop_create_charge");
    expect(openai.function.description).toBe("Create a Pix charge");
    expect(openai.function.parameters).toEqual(tool.inputSchema);
  });
});

describe("handleToolCall", () => {
  it("finds and executes correct tool", async () => {
    const session = mockSession([
      mockTool({ slug: "zoop_create_charge", name: "ZOOP_CREATE_CHARGE" }),
      mockTool({ slug: "nfe_issue", name: "NFE_ISSUE" }),
    ]);

    const result = await handleToolCall(session, "zoop_create_charge", { amount: 150 });

    expect(session.execute).toHaveBeenCalledWith("ZOOP_CREATE_CHARGE", { amount: 150 });
    expect(JSON.parse(result)).toEqual({ id: "ch_1" });
  });

  it("throws for unknown tool", async () => {
    const session = mockSession([]);
    await expect(handleToolCall(session, "nonexistent", {})).rejects.toThrow("Unknown tool: nonexistent");
  });
});
