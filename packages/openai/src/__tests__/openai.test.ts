/**
 * @codespar/openai basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { toOpenAITool, getTools, handleToolCall } from "../index.js";

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
    async tools() {
      return tools;
    },
    async execute(toolName: string): Promise<ToolResult> {
      return {
        success: true,
        data: { ok: true },
        error: null,
        duration: 10,
        server: "codespar",
        tool: toolName,
      };
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
    async authorize() { return { linkToken: "tok_test", authorizeUrl: "https://provider.example.com/authorize", expiresAt: new Date(Date.now() + 600_000).toISOString() }; },
    async connections() {
      return [];
    },
    async discover() { return { tools: [] } as any; },
    async connectionWizard() { return {} as any; },
    async charge() { return {} as any; },
    async ship() { return {} as any; },
    async paymentStatus() { return { status: 'pending' } as any; },
    async paymentStatusStream() { return {} as any; },
    async verificationStatus() { return { status: 'pending' } as any; },
    async verificationStatusStream() { return {} as any; },
    async close() {
      // noop
    },
  };
  return session;
}

describe("@codespar/openai", () => {
  it("toOpenAITool wraps tool in function envelope", () => {
    const tool = makeTool();
    const fn = toOpenAITool(tool);
    expect(fn.type).toBe("function");
    expect(fn.function.name).toBe("codespar_pay");
    expect(fn.function.description).toBe("Execute a payment");
    expect(fn.function.parameters).toEqual(tool.input_schema);
  });

  it("getTools returns OpenAI function array", async () => {
    const session = fakeSession([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const fns = await getTools(session);
    expect(fns).toHaveLength(2);
    expect(fns[0]!.function.name).toBe("codespar_pay");
    expect(fns[1]!.function.name).toBe("codespar_invoice");
  });

  it("handleToolCall executes via session", async () => {
    const session = fakeSession([makeTool()]);
    const result = await handleToolCall(session, "codespar_pay", { amount: 50 });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("codespar_pay");
  });
});
