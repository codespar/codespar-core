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

/**
 * Claude tool definition, estruturalmente atribuivel a `Anthropic.Tool`.
 *
 * ⚠️ `type: "object"` E O PONTO, e ele faltava. O `input_schema` da Anthropic e
 * `{ type: "object"; properties?: unknown | null; required?: string[] | null;
 * [k: string]: unknown }`, e este tipo declarava so `Record<string, unknown>`.
 * O resultado: `ClaudeTool[]` nao era atribuivel a `ToolUnion[]`, entao passar
 * a saida de `getTools()` direto para `claude.messages.create({ tools })` — que
 * e o uso que o exemplo no topo deste arquivo mostra e que a doc publica —
 * reprovava no `tsc`. Em runtime sempre funcionou.
 *
 * O indice de sobra (`[key: string]: unknown`) fica porque o JSON Schema que o
 * servidor manda pode trazer `$schema`, `additionalProperties` e afins, e
 * remove-los seria mentir sobre o que vai no fio.
 *
 * Nao importamos o tipo da Anthropic de proposito: este pacote nao depende de
 * `@anthropic-ai/sdk`, e a compatibilidade aqui e ESTRUTURAL. O teste
 * `atribuivel-ao-sdk-da-anthropic` fixa isso com uma copia da declaracao deles.
 */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown> | null;
    required?: string[] | null;
    [key: string]: unknown;
  };
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
    // O espalhamento vem ANTES: assim `type` e GARANTIDO, nao afirmado. Um
    // schema que ja diga `type: "object"` continua igual; um que nao diga passa
    // a dizer, que e o que a Anthropic exige e o que ele sempre foi na pratica.
    input_schema: { ...tool.input_schema, type: "object" },
  };
}

/**
 * Execute a Claude tool_use block by routing through the CodeSpar session.
 * Returns the raw ToolResult — the caller is responsible for serializing
 * it into a Claude tool_result block.
 */
export async function handleToolUse(
  session: Session,
  // ⚠️ `input` e `unknown`, e nao `Record<string, unknown>`, porque e assim que
  // o `ToolUseBlock` da Anthropic o declara. Com o tipo estreito, passar o
  // bloco direto — o uso que o exemplo no topo mostra — reprovava no `tsc`.
  toolUse: { name: string; input?: unknown },
): Promise<ToolResult> {
  const input = toolUse.input;
  const params = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return session.execute(toolUse.name, params);
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
