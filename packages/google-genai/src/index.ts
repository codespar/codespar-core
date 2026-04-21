/**
 * @codespar/google-genai — Google Gemini/GenAI adapter
 *
 * Bridges CodeSpar session tools to Google's Gemini function calling
 * format (FunctionDeclaration).
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getToolsConfig, handleFunctionCall } from "@codespar/google-genai";
 * import { GoogleGenerativeAI } from "@google/generative-ai";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const toolsConfig = await getToolsConfig(session);
 *
 * const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
 * const model = genAI.getGenerativeModel({
 *   model: "gemini-1.5-pro",
 *   tools: toolsConfig,
 * });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Convert CodeSpar session tools to Gemini FunctionDeclaration array. */
export async function getTools(session: Session): Promise<GeminiFunctionDeclaration[]> {
  const tools = await getSessionTools(session);
  return tools.map(toGeminiTool);
}

/**
 * Get the full tools config ready to pass to getGenerativeModel().
 * Wraps FunctionDeclarations in the { functionDeclarations } envelope.
 */
export async function getToolsConfig(
  session: Session,
): Promise<{ functionDeclarations: GeminiFunctionDeclaration[] }[]> {
  const declarations = await getTools(session);
  return [{ functionDeclarations: declarations }];
}

/** Convert a single CodeSpar tool to Gemini FunctionDeclaration. */
export function toGeminiTool(tool: Tool): GeminiFunctionDeclaration {
  const schema = tool.input_schema;
  return {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: "object",
      properties: (schema.properties ?? {}) as Record<string, unknown>,
      required: schema.required as string[] | undefined,
    },
  };
}

/**
 * Execute a Gemini function call by routing through the CodeSpar session
 * so billing and audit are recorded.
 */
export async function handleFunctionCall(
  session: Session,
  functionCall: { name: string; args: Record<string, unknown> },
): Promise<ToolResult> {
  return session.execute(functionCall.name, functionCall.args);
}
