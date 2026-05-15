/**
 * @codespar/vercel basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Tool, ToolResult } from "@codespar/sdk";
import { fakeSession } from "@codespar/sdk/testing";
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

function fakeSessionFromTools(tools: Tool[], execResult?: ToolResult) {
  const responses: Record<
    string,
    (input: Record<string, unknown>) => ToolResult
  > = {};
  for (const t of tools) {
    responses[t.name] = () =>
      execResult ?? {
        success: true,
        data: { ok: true },
        error: null,
        duration: 10,
        server: "codespar",
        tool: t.name,
      };
  }
  const session = fakeSession(responses);
  return Object.assign(session, {
    async tools() {
      return tools;
    },
  });
}

describe("@codespar/vercel", () => {
  it("toVercelTool produces { description, parameters, execute }", () => {
    const tool = makeTool();
    const session = fakeSessionFromTools([tool]);
    const vt = toVercelTool(tool, session);
    expect(vt.description).toBe("Execute a payment");
    expect(vt.parameters).toEqual(tool.input_schema);
    expect(typeof vt.execute).toBe("function");
  });

  it("getTools returns a record keyed by tool name", async () => {
    const session = fakeSessionFromTools([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const tools = await getTools(session);
    expect(Object.keys(tools).sort()).toEqual(["codespar_invoice", "codespar_pay"]);
  });

  it("execute returns data on success", async () => {
    const tool = makeTool();
    const session = fakeSessionFromTools([tool]);
    const vt = toVercelTool(tool, session);
    const data = await vt.execute({ amount: 50 });
    expect(data).toEqual({ ok: true });
  });

  it("execute throws on failure", async () => {
    const tool = makeTool();
    const session = fakeSessionFromTools([tool], {
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
