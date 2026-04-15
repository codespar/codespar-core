/**
 * @codespar/vercel — Vercel AI SDK adapter
 *
 * Converts CodeSpar session tools into Vercel AI SDK tool format
 * for use with generateText, streamText, etc.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/vercel";
 * import { generateText } from "ai";
 *
 * const cs = new CodeSpar({ apiKey: "ak_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 * const tools = getTools(session);
 *
 * const result = await generateText({
 *   model: openai("gpt-4o"),
 *   tools,
 *   prompt: "Charge R$150 via Pix",
 * });
 * ```
 */

import type { Session, Tool } from "@codespar/sdk";

export interface VercelTool {
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Convert a CodeSpar session's tools into Vercel AI SDK tool format.
 */
export function getTools(session: Session): Record<string, VercelTool> {
  const tools = session.tools();
  const result: Record<string, VercelTool> = {};

  for (const tool of tools) {
    result[tool.slug] = {
      description: tool.description,
      parameters: tool.inputSchema,
      execute: async (params: Record<string, unknown>) => {
        const res = await session.execute(tool.name, params);
        if (!res.success) throw new Error(res.error || "Tool execution failed");
        return res.data;
      },
    };
  }

  return result;
}

/**
 * Convert a single CodeSpar tool into Vercel AI SDK format.
 */
export function toVercelTool(tool: Tool, session: Session): VercelTool {
  return {
    description: tool.description,
    parameters: tool.inputSchema,
    execute: async (params: Record<string, unknown>) => {
      const res = await session.execute(tool.name, params);
      if (!res.success) throw new Error(res.error || "Tool execution failed");
      return res.data;
    },
  };
}
