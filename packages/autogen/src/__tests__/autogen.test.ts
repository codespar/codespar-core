/**
 * @codespar/autogen basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { toAutoGenTool, getTools, handleToolCall } from "../index.js";

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
  return {
    id: "ses_fake",
    userId: "user_1",
    servers: [],
    createdAt: new Date(),
    status: "active",
    mcp: { url: "https://api.example.com/v1/sessions/ses_fake/mcp", headers: {} },
    async tools() { return tools; },
    async findTools() { return tools; },
    async execute(toolName: string): Promise<ToolResult> {
      return { success: true, data: { ok: true }, error: null, duration: 10, server: "codespar", tool: toolName };
    },
    async loop() { return { success: true, results: [], duration: 0, completedSteps: 0, totalSteps: 0 }; },
    async send() { return { message: "", tool_calls: [], iterations: 0 }; },
    async *sendStream() {},
    async authorize() { return { connected: false }; },
    async connections() { return []; },
    async close() {},
  };
}

describe("@codespar/autogen", () => {
  it("toAutoGenTool wraps tool in function envelope with callable", () => {
    const session = fakeSession([makeTool()]);
    const fn = toAutoGenTool(makeTool(), session);
    expect(fn.type).toBe("function");
    expect(fn.function.name).toBe("codespar_pay");
    expect(fn.function.description).toBe("Execute a payment");
    expect(fn.function.parameters).toEqual(makeTool().input_schema);
    expect(typeof fn.callable).toBe("function");
  });

  it("getTools returns array of AutoGen tools", async () => {
    const session = fakeSession([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const fns = await getTools(session);
    expect(fns).toHaveLength(2);
    expect(fns[0]!.function.name).toBe("codespar_pay");
    expect(fns[1]!.function.name).toBe("codespar_invoice");
  });

  it("callable routes through session.execute", async () => {
    const session = fakeSession([makeTool()]);
    const fn = toAutoGenTool(makeTool(), session);
    const result = await fn.callable({ amount: 50 });
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("handleToolCall executes via session", async () => {
    const session = fakeSession([makeTool()]);
    const result = await handleToolCall(session, "codespar_pay", { amount: 50 });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("codespar_pay");
  });
});
