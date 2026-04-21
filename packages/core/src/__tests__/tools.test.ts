import { describe, it, expect } from "vitest";
import { tools, findTools } from "../tools.js";
import type { SessionBase } from "@codespar/types";
import type { Tool } from "../types.js";

function makeSession(overrides: Partial<SessionBase & { tools?(): Promise<Tool[]> }> = {}): SessionBase {
  return {
    id: "ses_1",
    status: "active",
    async execute() { return { success: true, data: null, error: null, duration: 0, server: "", tool: "" }; },
    async send() { return { message: "", tool_calls: [], iterations: 0 }; },
    async *sendStream() {},
    async connections() { return []; },
    async close() {},
    ...overrides,
  };
}

const fakeTool = (name: string, description: string): Tool => ({
  name,
  description,
  input_schema: {},
  server: "test",
});

describe("tools()", () => {
  it("returns [] when session has no internal tools() method", async () => {
    const session = makeSession();
    expect(await tools(session)).toEqual([]);
  });

  it("delegates to session.tools() when present", async () => {
    const list = [fakeTool("PAY", "process payment")];
    const session = makeSession({ tools: async () => list });
    expect(await tools(session)).toBe(list);
  });
});

describe("findTools()", () => {
  const session = makeSession({
    tools: async () => [
      fakeTool("PIX_CHARGE", "create a pix charge"),
      fakeTool("NFE_EMIT", "emit a nota fiscal"),
      fakeTool("SHIP_LABEL", "generate shipping label"),
    ],
  });

  it("matches by tool name (case-insensitive)", async () => {
    const result = await findTools(session, "pix");
    expect(result.map((t) => t.name)).toEqual(["PIX_CHARGE"]);
  });

  it("matches by description (case-insensitive)", async () => {
    const result = await findTools(session, "nota fiscal");
    expect(result.map((t) => t.name)).toEqual(["NFE_EMIT"]);
  });

  it("returns multiple matches", async () => {
    const result = await findTools(session, "label");
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("SHIP_LABEL");
  });

  it("returns [] when no tools match", async () => {
    expect(await findTools(session, "stripe")).toEqual([]);
  });

  it("returns all tools when session has no tools() method", async () => {
    expect(await findTools(makeSession(), "pix")).toEqual([]);
  });
});
