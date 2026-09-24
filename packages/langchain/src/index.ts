/**
 * @codespar/langchain — LangChain.js StructuredTool adapter
 *
 * Bridges CodeSpar session tools to LangChain's StructuredTool format.
 * Converts each tool's JSON Schema input to a Zod schema that accepts the
 * same values (see schema.ts) and creates tool objects that route execution
 * through the CodeSpar session for billing and audit.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 * import { getTools } from "@codespar/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 * import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { servers: ["stripe"] });
 * const tools = await getTools(session);
 *
 * const llm = new ChatOpenAI({ model: "gpt-4o" });
 * const agent = createToolCallingAgent({ llm, tools, prompt });
 * const executor = new AgentExecutor({ agent, tools });
 * const result = await executor.invoke({ input: "Charge R$150 via Pix" });
 * ```
 */

import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";
import { jsonSchemaToZod, type ToolInputSchema } from "./schema.js";

export interface CodeSparLangChainTool {
  name: string;
  description: string;
  /**
   * The Zod form of the tool's `input_schema`: a `ZodObject`, or a
   * `ZodEffects` over one when the root schema carries a combinator beside
   * its properties. LangChain accepts either; `toolInputShape(schema)`
   * reaches the properties in both.
   */
  schema: ToolInputSchema;
  invoke(input: Record<string, unknown>): Promise<string>;
}

/**
 * Convert CodeSpar session tools into LangChain-compatible tool objects.
 * Each tool has a Zod schema and an invoke method that routes through
 * the CodeSpar session.
 */
export async function getTools(session: Session): Promise<CodeSparLangChainTool[]> {
  const tools = await getSessionTools(session);
  return tools.map((t) => toLangChainTool(t, session));
}

/** Convert a single CodeSpar tool to LangChain format. */
export function toLangChainTool(tool: Tool, session: Session): CodeSparLangChainTool {
  return {
    name: tool.name,
    description: tool.description,
    schema: jsonSchemaToZod(tool.input_schema),
    invoke: async (input: Record<string, unknown>): Promise<string> => {
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

export {
  KEYWORD_SUPPORT,
  MARKED_KEYWORDS,
  renderKeywordTable,
  type KeywordSupport,
  jsonSchemaToZod,
  jsonSchemaToZodType,
  toolInputObject,
  toolInputShape,
  type JsonSchema,
  type ToolInputSchema,
} from "./schema.js";
