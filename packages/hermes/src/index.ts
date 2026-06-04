/**
 * @codespar/hermes — Hermes Agent (Nous Research) tool adapter
 *
 * Bridges CodeSpar session tools to Hermes Agent's tool format. Hermes
 * consumes external tools as MCP servers / plugins, so each tool follows
 * the MCP tool spec — `name`, `description`, `inputSchema` (JSON Schema) —
 * plus an async `call` that routes through the CodeSpar session for
 * billing and audit.
 *
 * Hermes agents ship with a Privy-secured embedded wallet and credit
 * billing but no commerce rail; these tools give them LATAM commerce
 * (pay / charge / invoice / ship / notify).
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/hermes";
 *
 * const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 * const tools = await getTools(session);
 *
 * // Register the tools with your Hermes plugin / MCP bridge.
 * for (const tool of tools) {
 *   plugin.registerTool(tool);
 * }
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

/**
 * Hermes tool definition — mirrors the MCP tool spec (name / description /
 * inputSchema) with an async `call` that returns a string result.
 */
export interface HermesTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(input: Record<string, unknown>): Promise<string>;
}

/** Convert CodeSpar session tools to Hermes tool format. */
export async function getTools(session: Session): Promise<HermesTool[]> {
  const tools = await getSessionTools(session);
  return tools.map((t) => toHermesTool(t, session));
}

/** Convert a single CodeSpar tool to Hermes format. */
export function toHermesTool(tool: Tool, session: Session): HermesTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
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
