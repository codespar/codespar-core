/**
 * The reference harness: a tool-use loop on `@anthropic-ai/sdk`. It only
 * turns messages into a request and the response into tool calls or a
 * reply; it never decides anything about money.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageParam, Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import type { AgentRuntime, ConversationMessage, Reply, ToolCall, ToolSpec, Turn } from "./types.js";

export const DEFAULT_MODEL = "claude-sonnet-5";

export interface AnthropicRuntimeOptions {
  apiKey?: string | undefined;
  model?: string;
  maxTokens?: number;
}

export class AnthropicRuntime implements AgentRuntime {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: AnthropicRuntimeOptions = {}) {
    const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set; use the replay provider for runs without a model");
    this.client = new Anthropic({ apiKey });
    this.model = options.model ?? process.env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL;
    this.maxTokens = options.maxTokens ?? 1024;
  }

  async step(input: Turn, tools: ToolSpec[]): Promise<ToolCall[] | Reply> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: input.system,
      tools: tools.map(toAnthropicTool),
      messages: toAnthropicMessages(input.messages),
    });
    const calls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") calls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      else if (block.type === "text") text.push(block.text);
    }
    if (calls.length > 0) return calls;
    return { text: text.join("\n").trim() };
  }
}

function toAnthropicTool(tool: ToolSpec): AnthropicTool {
  return { name: tool.name, description: tool.description, input_schema: tool.input_schema as AnthropicTool["input_schema"] };
}

function toAnthropicMessages(messages: ConversationMessage[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const content: ContentBlockParam[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const call of m.tool_calls ?? []) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      out.push({ role: "assistant", content });
    } else {
      const last = out[out.length - 1];
      const block = { type: "tool_result" as const, tool_use_id: m.tool_call_id, content: m.content, ...(m.is_error ? { is_error: true } : {}) };
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === "tool_result")) {
        (last.content as Array<typeof block>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}
