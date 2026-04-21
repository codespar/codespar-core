/**
 * @codespar/langchain — LangChain.js StructuredTool adapter
 *
 * Bridges CodeSpar session tools to LangChain's StructuredTool format.
 * Converts JSON Schema inputs to Zod schemas and creates class instances
 * that route execution through the CodeSpar session for billing and audit.
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

import { z } from "zod";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import { tools as getSessionTools } from "@codespar/sdk";

/** Convert a JSON Schema object to a Zod object schema. */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<z.ZodRawShape> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const shape: z.ZodRawShape = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.unknown());
        break;
      default:
        field = z.string();
    }
    if (prop.description) field = field.describe(prop.description as string);
    shape[key] = required.includes(key) ? field : field.optional();
  }

  return z.object(shape);
}

export interface CodeSparLangChainTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
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

export { jsonSchemaToZod };
