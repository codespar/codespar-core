/**
 * The deterministic provider. It reads the `assistant_step` lines of a
 * recorded transcript and answers them in order, so the CI, the scenarios
 * and `npm run rerun` run with no model and no network. The recorded lines
 * are the MODEL's outputs only; everything the core decided is recomputed
 * live, which is what makes a rerun a test rather than a printout.
 */
import { readFileSync } from "node:fs";
import type { AgentRuntime, Reply, ToolCall, ToolSpec, Turn } from "./types.js";

export interface RecordedStep {
  kind: "assistant_step";
  tool_calls?: ToolCall[];
  reply?: string;
}

export class ReplayExhaustedError extends Error {
  constructor(consumed: number) {
    super(`replay transcript exhausted after ${consumed} step(s); the run asked the model more than the recording holds`);
    this.name = "ReplayExhaustedError";
  }
}

export class ReplayRuntime implements AgentRuntime {
  readonly name = "replay";
  private cursor = 0;

  constructor(private readonly steps: RecordedStep[]) {}

  static fromFile(path: string): ReplayRuntime {
    return new ReplayRuntime(parseTranscript(readFileSync(path, "utf8")));
  }

  static fromLines(lines: Array<Record<string, unknown>>): ReplayRuntime {
    return new ReplayRuntime(lines.filter((l) => l["kind"] === "assistant_step") as unknown as RecordedStep[]);
  }

  get consumed(): number {
    return this.cursor;
  }

  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  async step(_input: Turn, _tools: ToolSpec[]): Promise<ToolCall[] | Reply> {
    const next = this.steps[this.cursor];
    if (!next) throw new ReplayExhaustedError(this.cursor);
    this.cursor += 1;
    if (next.tool_calls && next.tool_calls.length > 0) {
      return next.tool_calls.map((c, i) => ({ id: c.id ?? `tc_${this.cursor}_${i}`, name: c.name, input: c.input ?? {} }));
    }
    return { text: next.reply ?? "" };
  }
}

export function parseTranscript(text: string): RecordedStep[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l["kind"] === "assistant_step") as unknown as RecordedStep[];
}
