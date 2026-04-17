/**
 * @codespar/llama-index — LlamaIndex.TS adapter
 *
 * Bridges CodeSpar session tools to LlamaIndex's FunctionTool format.
 * Each tool has a `call` method that routes through the CodeSpar session
 * for billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/llama-index";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * // Use with a LlamaIndex agent
 * const agent = new OpenAIAgent({ tools });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";

export interface LlamaIndexTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  call(input: Record<string, unknown>): Promise<string>;
}

/** Convert CodeSpar session tools to LlamaIndex tool format. */
export async function getTools(session: Session): Promise<LlamaIndexTool[]> {
  const tools = await session.tools();
  return tools.map((t) => toLlamaIndexTool(t, session));
}

/** Convert a single CodeSpar tool to LlamaIndex format. */
export function toLlamaIndexTool(tool: Tool, session: Session): LlamaIndexTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    call: async (input: Record<string, unknown>): Promise<string> => {
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
