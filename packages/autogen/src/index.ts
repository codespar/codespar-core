/**
 * @codespar/autogen — Microsoft AutoGen adapter
 *
 * Bridges CodeSpar session tools to AutoGen's function tool format.
 * Each tool includes a `callable` that routes through the CodeSpar
 * session for billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/autogen";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * // Register tools with AutoGen agents
 * const assistant = new AssistantAgent({ name: "commerce", tools });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

export interface AutoGenFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  callable: (args: Record<string, unknown>) => Promise<string>;
}

/** Convert CodeSpar session tools to AutoGen function tool format. */
export async function getTools(session: Session): Promise<AutoGenFunctionTool[]> {
  const tools = await getSessionTools(session);
  return tools.map((t) => toAutoGenTool(t, session));
}

/** Convert a single CodeSpar tool to AutoGen format. */
export function toAutoGenTool(tool: Tool, session: Session): AutoGenFunctionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
    callable: async (args: Record<string, unknown>): Promise<string> => {
      const result = await session.execute(tool.name, args);
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
