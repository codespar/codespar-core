/**
 * @codespar/claude basic tests for 0.2.0.
 */

import { describe, it, expect } from "vitest";
import type { Tool, ToolResult } from "@codespar/sdk";
import { fakeSession } from "@codespar/sdk/testing";
import { toClaudeTool, toToolResultBlock, getTools, handleToolUse } from "../index.js";

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "codespar_pay",
    description: "Execute a payment",
    input_schema: { type: "object", properties: { amount: { type: "number" } } },
    server: "codespar",
    ...overrides,
  };
}

function fakeSessionFromTools(tools: Tool[]) {
  const responses: Record<
    string,
    (input: Record<string, unknown>) => ToolResult
  > = {};
  for (const t of tools) {
    responses[t.name] = () => ({
      success: true,
      data: { ok: true },
      error: null,
      duration: 10,
      server: "codespar",
      tool: t.name,
    });
  }
  const session = fakeSession(responses);
  // The adapter calls session.tools(); the published Session interface does
  // not declare tools(), so we attach it here at the call site (the SDK's
  // `tools()` free function uses duck typing — see packages/core/src/tools.ts).
  return Object.assign(session, {
    async tools() {
      return tools;
    },
  });
}

describe("@codespar/claude", () => {
  it("toClaudeTool maps to Anthropic shape", () => {
    const tool = makeTool();
    const claudeTool = toClaudeTool(tool);
    expect(claudeTool.name).toBe("codespar_pay");
    expect(claudeTool.description).toBe("Execute a payment");
    expect(claudeTool.input_schema).toEqual(tool.input_schema);
  });

  it("getTools awaits session.tools()", async () => {
    const session = fakeSessionFromTools([makeTool(), makeTool({ name: "codespar_invoice" })]);
    const tools = await getTools(session);
    expect(tools).toHaveLength(2);
    expect(tools[0]!.name).toBe("codespar_pay");
    expect(tools[1]!.name).toBe("codespar_invoice");
  });

  it("handleToolUse routes through session.execute", async () => {
    const session = fakeSessionFromTools([makeTool()]);
    const result = await handleToolUse(session, { name: "codespar_pay", input: { amount: 50 } });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("codespar_pay");
  });

  it("toToolResultBlock formats success", () => {
    const block = toToolResultBlock("toolu_1", {
      success: true,
      data: { txn: "abc" },
      error: null,
      duration: 10,
      server: "zoop",
      tool: "codespar_pay",
    });
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_1");
    expect(block.is_error).toBe(false);
    expect(JSON.parse(block.content)).toEqual({ txn: "abc" });
  });

  it("toToolResultBlock formats errors", () => {
    const block = toToolResultBlock("toolu_2", {
      success: false,
      data: null,
      error: "boom",
      duration: 10,
      server: "zoop",
      tool: "codespar_pay",
    });
    expect(block.is_error).toBe(true);
    expect(JSON.parse(block.content)).toEqual({ error: "boom" });
  });
});
