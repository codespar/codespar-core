/**
 * @codespar/claude — Claude Agent SDK adapter
 *
 * Converts CodeSpar session tools into Anthropic Claude tool format.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/claude";
 *
 * const cs = new CodeSpar({ apiKey: "ak_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 * const tools = getTools(session);
 * ```
 */

import type { Session, Tool } from "@codespar/sdk";

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeToolWithExecute extends ClaudeTool {
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Convert CodeSpar session tools to Claude API tool format.
 */
export function getTools(session: Session): ClaudeToolWithExecute[] {
  return session.tools().map((tool) => toClaudeTool(tool, session));
}

/**
 * Convert a single CodeSpar tool to Claude format.
 */
export function toClaudeTool(tool: Tool, session: Session): ClaudeToolWithExecute {
  return {
    name: tool.slug,
    description: tool.description,
    input_schema: tool.inputSchema,
    execute: async (input: Record<string, unknown>) => {
      const res = await session.execute(tool.name, input);
      if (!res.success) throw new Error(res.error || "Tool execution failed");
      return res.data;
    },
  };
}

/**
 * Get tools as plain Claude API format (without execute, for manual handling).
 */
export function getToolDefinitions(session: Session): ClaudeTool[] {
  return session.tools().map((tool) => ({
    name: tool.slug,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
