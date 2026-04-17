/**
 * @codespar/google-genai basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { toGeminiTool, getTools, getToolsConfig, handleFunctionCall } from "../index.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "codespar_pay",
    description: "Execute a payment",
    input_schema: {
      type: "object",
      properties: { amount: { type: "number" } },
      required: ["amount"],
    },
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

describe("@codespar/google-genai", () => {
  it("toGeminiTool converts to FunctionDeclaration", () => {
    const fn = toGeminiTool(makeTool());
    expect(fn.name).toBe("codespar_pay");
    expect(fn.description).toBe("Execute a payment");
    expect(fn.parameters.type).toBe("object");
    expect(fn.parameters.properties).toEqual({ amount: { type: "number" } });
    expect(fn.parameters.required).toEqual(["amount"]);
  });

  it("getTools returns FunctionDeclaration array", async () => {
    const session = fakeSession([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const fns = await getTools(session);
    expect(fns).toHaveLength(2);
    expect(fns[0]!.name).toBe("codespar_pay");
    expect(fns[1]!.name).toBe("codespar_invoice");
  });

  it("getToolsConfig wraps in functionDeclarations envelope", async () => {
    const session = fakeSession([makeTool()]);
    const config = await getToolsConfig(session);
    expect(config).toHaveLength(1);
    expect(config[0]!.functionDeclarations).toHaveLength(1);
    expect(config[0]!.functionDeclarations[0]!.name).toBe("codespar_pay");
  });

  it("handleFunctionCall executes via session", async () => {
    const session = fakeSession([makeTool()]);
    const result = await handleFunctionCall(session, { name: "codespar_pay", args: { amount: 50 } });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("codespar_pay");
  });
});
