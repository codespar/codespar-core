/**
 * Section 13: the contract of the harness file. Policy stays outside the
 * provider: the state machine, the mandate, the guardrails and `tools.json`
 * are the core's. Changing the model changes nothing about what can be paid.
 */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Reply {
  text: string;
}

export type ConversationMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string; is_error?: boolean };

export interface Turn {
  system: string;
  messages: ConversationMessage[];
}

export interface AgentRuntime {
  readonly name: string;
  step(input: Turn, tools: ToolSpec[]): Promise<ToolCall[] | Reply>;
}

export function isReply(out: ToolCall[] | Reply): out is Reply {
  return !Array.isArray(out);
}
