/**
 * @codespar/claude — Claude API tool adapter
 *
 * Bridges CodeSpar session tools to Anthropic's Claude tool format. The
 * dev owns the agent loop (using @anthropic-ai/sdk directly); this package
 * just shapes tools and provides an executor that routes back through the
 * CodeSpar session for billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools, handleToolUse } from "@codespar/claude";
 * import Anthropic from "@anthropic-ai/sdk";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["zoop"] });
 * const tools = await getTools(session);
 *
 * const claude = new Anthropic();
 * const response = await claude.messages.create({
 *   model: "claude-opus-4-6",
 *   max_tokens: 1024,
 *   tools,
 *   messages: [{ role: "user", content: "Charge R$150 via Pix" }],
 * });
 *
 * for (const block of response.content) {
 *   if (block.type === "tool_use") {
 *     const result = await handleToolUse(session, block);
 *     // ... feed result back to Claude as a tool_result block
 *   }
 * }
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

/** Claude tool definition (matches Anthropic.Tool from @anthropic-ai/sdk). */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Convert CodeSpar session tools into Claude API tool definitions.
 * Loads tools from the backend via session.tools() if not already cached.
 */
export async function getTools(session: Session): Promise<ClaudeTool[]> {
  const tools = await getSessionTools(session);
  return tools.map(toClaudeTool);
}

/** Convert a single CodeSpar tool to Claude format. */
export function toClaudeTool(tool: Tool): ClaudeTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  };
}

/**
 * Execute a Claude tool_use block by routing through the CodeSpar session.
 * Returns the raw ToolResult — the caller is responsible for serializing
 * it into a Claude tool_result block.
 */
export async function handleToolUse(
  session: Session,
  toolUse: { name: string; input: Record<string, unknown> },
): Promise<ToolResult> {
  return session.execute(toolUse.name, toolUse.input);
}

/**
 * Convenience: build a Claude tool_result block from a ToolResult.
 *
 * @example
 * ```ts
 * const result = await handleToolUse(session, block);
 * messages.push({
 *   role: "user",
 *   content: [toToolResultBlock(block.id, result)],
 * });
 * ```
 */
export function toToolResultBlock(
  toolUseId: string,
  result: ToolResult,
): { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean } {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content:
      result.success
        ? JSON.stringify(result.data)
        : JSON.stringify({ error: result.error }),
    is_error: !result.success,
  };
}
