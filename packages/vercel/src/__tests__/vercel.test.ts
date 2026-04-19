/**
 * @codespar/vercel basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { toVercelTool, getTools } from "../index.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "codespar_pay",
    description: "Execute a payment",
    input_schema: { type: "object", properties: { amount: { type: "number" } } },
    server: "codespar",
    ...overrides,
  };
}

function fakeSession(tools: Tool[], execResult?: ToolResult): Session {
  return {
    id: "ses_fake",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    status: "active",
    mcp: { url: "https://api.example.com/v1/sessions/ses_fake/mcp", headers: {} },
    async tools() {
      return tools;
    },
    async findTools() {
      return tools;
    },
    async execute(toolName: string): Promise<ToolResult> {
      return (
        execResult ?? {
          success: true,
          data: { ok: true },
          error: null,
          duration: 10,
          server: "codespar",
          tool: toolName,
        }
      );
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

describe("@codespar/vercel", () => {
  it("toVercelTool produces { description, parameters, execute }", () => {
    const tool = makeTool();
    const session = fakeSession([tool]);
    const vt = toVercelTool(tool, session);
    expect(vt.description).toBe("Execute a payment");
    expect(vt.parameters).toEqual(tool.input_schema);
    expect(typeof vt.execute).toBe("function");
  });

  it("getTools returns a record keyed by tool name", async () => {
    const session = fakeSession([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const tools = await getTools(session);
    expect(Object.keys(tools).sort()).toEqual(["codespar_invoice", "codespar_pay"]);
  });

  it("execute returns data on success", async () => {
    const tool = makeTool();
    const session = fakeSession([tool]);
    const vt = toVercelTool(tool, session);
    const data = await vt.execute({ amount: 50 });
    expect(data).toEqual({ ok: true });
  });

  it("execute throws on failure", async () => {
    const tool = makeTool();
    const session = fakeSession([tool], {
      success: false,
      data: null,
      error: "boom",
      duration: 5,
      server: "codespar",
      tool: tool.name,
    });
    const vt = toVercelTool(tool, session);
    await expect(vt.execute({ amount: 50 })).rejects.toThrow("boom");
  });
});
