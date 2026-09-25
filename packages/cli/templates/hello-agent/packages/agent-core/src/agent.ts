/**
 * The tool-use loop. The provider says what the model wants; this file
 * dispatches only the tools `tools.json` names, records every step in the
 * transcript, and hands payment tools to the engine, which is the only
 * thing that can move an execution past `drafted`.
 */
import type { ProofBundle } from "./bundle.js";
import type { ExecutionEngine } from "./engine.js";
import type { AgentRuntime, ConversationMessage, ToolCall, ToolSpec } from "./providers/types.js";
import { isReply } from "./providers/types.js";
import type { Execution } from "./state-machine.js";
import type { ToolsFile } from "./tools.js";
import { allowedToolNames, toolSpecs } from "./tools.js";

export interface ToolContext {
  engine: ExecutionEngine;
  /** Fires when a payment tool created an execution; the channel decides what to do with it (ask, or run). */
  onExecution: (execution: Execution) => Promise<Execution>;
}

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface AgentLoopOptions {
  runtime: AgentRuntime;
  tools: ToolsFile;
  handlers: Record<string, ToolHandler>;
  system: string;
  bundle: ProofBundle;
  engine: ExecutionEngine;
  onExecution: ToolContext["onExecution"];
  /** A hard stop on tool round-trips per turn, so a looping model cannot run forever. */
  maxSteps?: number;
  clock?: () => Date;
}

export interface TurnResult {
  reply: string;
  tool_calls: Array<{ name: string; refused: boolean }>;
  executions: Execution[];
}

export class AgentLoop {
  private readonly messages: ConversationMessage[] = [];
  private readonly allowed: Set<string>;
  private readonly specs: ToolSpec[];
  private readonly clock: () => Date;

  constructor(private readonly options: AgentLoopOptions) {
    this.allowed = allowedToolNames(options.tools);
    this.specs = toolSpecs(options.tools);
    this.clock = options.clock ?? (() => new Date());
  }

  get history(): readonly ConversationMessage[] {
    return this.messages;
  }

  async turn(userText: string): Promise<TurnResult> {
    const { runtime, bundle } = this.options;
    const maxSteps = this.options.maxSteps ?? 8;
    const calls: TurnResult["tool_calls"] = [];
    const executions: Execution[] = [];

    this.messages.push({ role: "user", content: userText });
    bundle.transcript({ at: this.now(), kind: "user", text: userText });

    for (let step = 0; step < maxSteps; step += 1) {
      const out = await runtime.step({ system: this.options.system, messages: this.messages }, this.specs);
      if (isReply(out)) {
        this.messages.push({ role: "assistant", content: out.text });
        bundle.transcript({ at: this.now(), kind: "assistant_step", reply: out.text });
        bundle.transcript({ at: this.now(), kind: "assistant", text: out.text });
        return { reply: out.text, tool_calls: calls, executions };
      }

      this.messages.push({ role: "assistant", content: "", tool_calls: out });
      bundle.transcript({ at: this.now(), kind: "assistant_step", tool_calls: out });

      for (const call of out) {
        const result = await this.dispatch(call, executions);
        calls.push({ name: call.name, refused: result.refused });
        this.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: JSON.stringify(result.content), ...(result.refused ? { is_error: true } : {}) });
        bundle.transcript({ at: this.now(), kind: "tool_result", tool_call_id: call.id, name: call.name, refused: result.refused, content: result.content });
      }
    }

    const text = "I stopped: too many tool steps in one turn. Nothing was paid beyond what the trail shows.";
    this.messages.push({ role: "assistant", content: text });
    bundle.transcript({ at: this.now(), kind: "assistant", text, truncated: true });
    return { reply: text, tool_calls: calls, executions };
  }

  private async dispatch(call: ToolCall, executions: Execution[]): Promise<{ refused: boolean; content: unknown }> {
    const { bundle, handlers, engine, onExecution } = this.options;
    bundle.transcript({ at: this.now(), kind: "tool_call", tool_call_id: call.id, name: call.name, input: call.input });

    if (!this.allowed.has(call.name)) {
      // Section 15, closed tools: a tool outside tools.json is refused, and the refusal is in the trail.
      bundle.event({ at: this.now(), type: "tool.refused", tool: call.name, reason: "tool_not_allowed", actor: engine.agentActor });
      return { refused: true, content: { error: "tool_not_allowed", message: `${call.name} is not in this agent's tools.json` } };
    }
    const handler = handlers[call.name];
    if (!handler) return { refused: true, content: { error: "tool_not_implemented", message: `${call.name} has no handler` } };

    try {
      const content = await handler(call.input, {
        engine,
        onExecution: async (execution) => {
          const settledOrNot = await onExecution(execution);
          executions.push(settledOrNot);
          return settledOrNot;
        },
      });
      return { refused: false, content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      bundle.event({ at: this.now(), type: "tool.error", tool: call.name, message, actor: engine.agentActor });
      return { refused: true, content: { error: "tool_failed", message } };
    }
  }

  private now(): string {
    return this.clock().toISOString();
  }
}
