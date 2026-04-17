/**
 * @codespar/crewai — CrewAI tool adapter
 *
 * Bridges CodeSpar session tools to CrewAI's tool format. Each tool
 * has a `run` method that routes through the CodeSpar session for
 * billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/crewai";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * // Pass tools to your CrewAI crew
 * const crew = new Crew({ agents, tasks, tools });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";

export interface CrewAITool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<string>;
}

/** Convert CodeSpar session tools to CrewAI tool format. */
export async function getTools(session: Session): Promise<CrewAITool[]> {
  const tools = await session.tools();
  return tools.map((t) => toCrewAITool(t, session));
}

/** Convert a single CodeSpar tool to CrewAI format. */
export function toCrewAITool(tool: Tool, session: Session): CrewAITool {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.input_schema,
    run: async (input: Record<string, unknown>): Promise<string> => {
      const result = await session.execute(tool.name, input);
      if (!result.success) throw new Error(result.error || "Tool execution failed");
      return JSON.stringify(result.data);
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
