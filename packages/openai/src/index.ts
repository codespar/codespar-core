/**
 * @codespar/openai — OpenAI Agents SDK adapter
 *
 * Converts CodeSpar session tools into OpenAI function calling format.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools, handleToolCall } from "@codespar/openai";
 *
 * const cs = new CodeSpar({ apiKey: "ak_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 * const tools = getTools(session);
 * ```
 */

import type { Session, Tool } from "@codespar/sdk";

export interface OpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert CodeSpar session tools to OpenAI function calling format.
 */
export function getTools(session: Session): OpenAIFunction[] {
  return session.tools().map((tool) => toOpenAITool(tool));
}

/**
 * Convert a single CodeSpar tool to OpenAI format.
 */
export function toOpenAITool(tool: Tool): OpenAIFunction {
  return {
    type: "function",
    function: {
      name: tool.slug,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Handle a tool call from OpenAI's response.
 * Pass the function name and arguments, get back the result.
 */
export async function handleToolCall(
  session: Session,
  functionName: string,
  args: Record<string, unknown>
): Promise<string> {
  const tools = session.tools();
  const tool = tools.find((t) => t.slug === functionName);
  if (!tool) throw new Error(`Unknown tool: ${functionName}`);

  const result = await session.execute(tool.name, args);
  return JSON.stringify(result.data);
}
