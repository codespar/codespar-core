/**
 * @codespar/vercel — Vercel AI SDK adapter
 *
 * Bridges CodeSpar session tools to the Vercel AI SDK's tool format for
 * use with generateText, streamText, etc.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/vercel";
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["zoop"] });
 * const tools = await getTools(session);
 *
 * const result = await generateText({
 *   model: openai("gpt-4o"),
 *   tools,
 *   prompt: "Charge R$150 via Pix",
 * });
 * ```
 */

import type { Session, Tool } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

export interface VercelTool {
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Convert a CodeSpar session's tools into Vercel AI SDK tool format.
 * The returned object is keyed by tool name and ready to pass to
 * generateText({ tools }).
 */
export async function getTools(session: Session): Promise<Record<string, VercelTool>> {
  const tools = await getSessionTools(session);
  const result: Record<string, VercelTool> = {};
  for (const tool of tools) {
    result[tool.name] = toVercelTool(tool, session);
  }
  return result;
}

/** Convert a single CodeSpar tool into Vercel AI SDK format. */
export function toVercelTool(tool: Tool, session: Session): VercelTool {
  return {
    description: tool.description,
    parameters: tool.input_schema,
    execute: async (params: Record<string, unknown>) => {
      const res = await session.execute(tool.name, params);
      if (!res.success) throw new Error(res.error || "Tool execution failed");
      return res.data;
    },
  };
}
