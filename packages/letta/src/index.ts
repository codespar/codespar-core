/**
 * @codespar/letta — Letta (MemGPT) adapter
 *
 * Bridges CodeSpar session tools to Letta's tool format. Each tool
 * includes a `callable` that routes through the CodeSpar session for
 * billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/letta";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * // Register tools with your Letta agent
 * const agent = client.createAgent({ tools });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

export interface LettaTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  callable: (args: Record<string, unknown>) => Promise<string>;
}

/** Convert CodeSpar session tools to Letta tool format. */
export async function getTools(session: Session): Promise<LettaTool[]> {
  const tools = await getSessionTools(session);
  return tools.map((t) => toLettaTool(t, session));
}

/** Convert a single CodeSpar tool to Letta format. */
export function toLettaTool(tool: Tool, session: Session): LettaTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
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
