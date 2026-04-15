import { describe, it, expect, vi } from "vitest";
import { getTools, toVercelTool } from "../index.js";
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
  it("converts session tools to Vercel format", () => {
    const session = mockSession([
      mockTool({ slug: "zoop_create_charge" }),
      mockTool({ slug: "nfe_issue", name: "NFE_ISSUE", description: "Issue NF-e" }),
    ]);

    const tools = getTools(session);

    expect(Object.keys(tools)).toEqual(["zoop_create_charge", "nfe_issue"]);
    expect(tools.zoop_create_charge.description).toBe("Create a Pix charge");
    expect(tools.zoop_create_charge.parameters).toBeDefined();
    expect(typeof tools.zoop_create_charge.execute).toBe("function");
  });

  it("returns empty object when no tools", () => {
    const session = mockSession([]);
    expect(getTools(session)).toEqual({});
  });
});

describe("toVercelTool", () => {
  it("produces correct structure", () => {
    const tool = mockTool();
    const session = mockSession();
    const vercel = toVercelTool(tool, session);

    expect(vercel).toEqual(
      expect.objectContaining({
        description: "Create a Pix charge",
        parameters: tool.inputSchema,
      })
    );
    expect(typeof vercel.execute).toBe("function");
  });
});

describe("execute delegation", () => {
  it("delegates to session.execute and returns data", async () => {
    const session = mockSession();
    const tools = getTools(session);
    const result = await tools.zoop_create_charge.execute({ amount: 150 });

    expect(session.execute).toHaveBeenCalledWith("ZOOP_CREATE_CHARGE", { amount: 150 });
    expect(result).toEqual({ id: "ch_1" });
  });

  it("throws on failed execution", async () => {
    const session = mockSession();
    (session.execute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      data: null,
      error: "Charge failed",
      duration: 10,
      server: "zoop",
      tool: "ZOOP_CREATE_CHARGE",
    });

    const tools = getTools(session);
    await expect(tools.zoop_create_charge.execute({ amount: 150 })).rejects.toThrow("Charge failed");
  });
});
