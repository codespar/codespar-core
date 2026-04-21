/**
 * @codespar/crewai basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { toCrewAITool, getTools, handleToolCall } from "../index.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "codespar_pay",
    description: "Execute a payment",
    input_schema: { type: "object", properties: { amount: { type: "number" } } },
    server: "codespar",
    ...overrides,
  };
}

function fakeSession(tools: Tool[]): Session {
  const session = {
    id: "ses_fake",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    status: "active" as const,
    mcp: { url: "https://api.example.com/v1/sessions/ses_fake/mcp", headers: {} },
    async tools() { return tools; },
    async execute(toolName: string): Promise<ToolResult> {
      return { success: true, data: { ok: true }, error: null, duration: 10, server: "codespar", tool: toolName };
    },
    async proxyExecute() { return { status: 200, data: null, headers: {}, duration: 0 }; },
    async send() { return { message: "", tool_calls: [], iterations: 0 }; },
    async *sendStream() {},
    async authorize() { return { linkToken: "tok_test", authorizeUrl: "https://provider.example.com/authorize", expiresAt: new Date(Date.now() + 600_000).toISOString() }; },
    async connections() { return []; },
    async close() {},
  };
  return session;
}

describe("@codespar/crewai", () => {
  it("toCrewAITool creates tool with correct shape", () => {
    const session = fakeSession([makeTool()]);
    const tool = toCrewAITool(makeTool(), session);
    expect(tool.name).toBe("codespar_pay");
    expect(tool.description).toBe("Execute a payment");
    expect(tool.schema).toEqual(makeTool().input_schema);
    expect(typeof tool.run).toBe("function");
  });

  it("getTools returns array of tools", async () => {
    const session = fakeSession([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const tools = await getTools(session);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("codespar_pay");
    expect(tools[1]!.name).toBe("codespar_invoice");
  });

  it("tool.run routes through session.execute", async () => {
    const session = fakeSession([makeTool()]);
    const tool = toCrewAITool(makeTool(), session);
    const result = await tool.run({ amount: 50 });
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("handleToolCall executes via session", async () => {
    const session = fakeSession([makeTool()]);
    const result = await handleToolCall(session, "codespar_pay", { amount: 50 });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("codespar_pay");
  });
});
