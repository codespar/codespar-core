/**
 * @codespar/openai — OpenAI function-calling adapter
 *
 * Bridges CodeSpar session tools to OpenAI's function calling format.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools, handleToolCall } from "@codespar/openai";
 * import OpenAI from "openai";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["zoop"] });
 * const tools = await getTools(session);
 *
 * const openai = new OpenAI();
 * const completion = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   tools,
 *   messages: [{ role: "user", content: "Charge R$150 via Pix" }],
 * });
 *
 * const call = completion.choices[0].message.tool_calls?.[0];
 * if (call) {
 *   const result = await handleToolCall(session, call.function.name, JSON.parse(call.function.arguments));
 * }
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";

export interface OpenAIFunction {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Convert CodeSpar session tools to OpenAI function-calling format. */
export async function getTools(session: Session): Promise<OpenAIFunction[]> {
  const tools = await session.tools();
  return tools.map(toOpenAITool);
}

/** Convert a single CodeSpar tool to OpenAI format. */
export function toOpenAITool(tool: Tool): OpenAIFunction {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/**
 * Execute a tool call returned by OpenAI. Routes through the CodeSpar
 * session so billing and audit are recorded.
 */
export async function handleToolCall(
  session: Session,
  functionName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return session.execute(functionName, args);
}
