/**
 * @codespar/mastra — Mastra AI adapter
 *
 * Bridges CodeSpar session tools to Mastra's tool format. Returns a
 * keyed record of tools ready to pass to a Mastra Agent.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/mastra";
 * import { Agent } from "@mastra/core";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * const agent = new Agent({ name: "commerce", tools });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";

export interface MastraTool {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (params: { context: Record<string, unknown> }) => Promise<unknown>;
}

/**
 * Convert CodeSpar session tools into Mastra tool format.
 * Returns a keyed record (by tool name) ready to pass to a Mastra Agent.
 */
export async function getTools(session: Session): Promise<Record<string, MastraTool>> {
  const tools = await session.tools();
  const result: Record<string, MastraTool> = {};
  for (const tool of tools) {
    result[tool.name] = toMastraTool(tool, session);
  }
  return result;
}

/** Convert a single CodeSpar tool to Mastra format. */
export function toMastraTool(tool: Tool, session: Session): MastraTool {
  return {
    id: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    execute: async (params: { context: Record<string, unknown> }): Promise<unknown> => {
      const result = await session.execute(tool.name, params.context);
      if (!result.success) throw new Error(result.error || "Tool execution failed");
      return result.data;
    },
  };
}

/**
 * Execute a tool call by routing through the CodeSpar session so billing
 * and audit are recorded.
 */
export async function handleToolCall(
  session: Session,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return session.execute(toolName, args);
}
