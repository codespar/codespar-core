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
