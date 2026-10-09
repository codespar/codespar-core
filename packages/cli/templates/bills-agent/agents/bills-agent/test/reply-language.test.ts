/**
 * The request the Anthropic provider actually sends, captured at `fetch`, for
 * one turn in each language (docs/OPEN_QUESTIONS.md §64). The real-model run
 * of 9a5383e answered five English requests out of five in Portuguese, with a
 * `## Language` rule in the system prompt. What these requests show: the
 * system prompt is the file, the person's words arrive untouched, and the
 * last user-role message the model reads before it replies is a tool result
 * full of Portuguese data. So "the language of the person's latest message"
 * was a rule the context argued against on every turn that used a tool. The
 * loop now reads the language of what the person typed and states it in the
 * system prompt of every step of that turn.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock, type Execution } from "@codespar/agent-core";
import { setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

interface SentRequest {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
}

function message(content: unknown[], stop: string) {
  return { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
}

/** The model's side, scripted: read the bills, then answer. Every request body is kept. */
function scriptedAnthropic(): SentRequest[] {
  const sent: SentRequest[] = [];
  const answers = [message([{ type: "tool_use", id: "toolu_1", name: "list_bills", input: {} }], "tool_use"), message([{ type: "text", text: "ok" }], "end_turn")];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
    sent.push(JSON.parse(String(init?.body)) as SentRequest);
    const body = answers[Math.min(sent.length - 1, answers.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return sent;
}

function open(): Setup {
  return setup(agent, {
    mode: "human",
    rail: "stub",
    provider: "anthropic",
    env: { ANTHROPIC_API_KEY: "sk-ant-test-not-a-key" },
    runsDir: mkdtempSync(join(tmpdir(), "bills-lang-runs-")),
    stateDir: mkdtempSync(join(tmpdir(), "bills-lang-state-")),
    now: fixedClock("2026-09-28T14:00:00-03:00"),
    say: () => undefined,
  });
}

async function oneTurn(text: string): Promise<SentRequest[]> {
  const sent = scriptedAnthropic();
  const s = open();
  try {
    const loop = s.makeLoop(s.makeRuntime(), async (e: Execution) => e);
    await loop.turn(text);
  } finally {
    s.close();
  }
  return sent;
}

const PROMPT = readFileSync(join(agent.dir, "SYSTEM_PROMPT.md"), "utf8");

afterEach(() => vi.unstubAllGlobals());

describe("the reply language travels in the request, not only in the prompt", () => {
  it("an English turn: every request of the turn states English, and the person's words arrive as typed", async () => {
    const sent = await oneTurn("pay the cleaner for September, please");
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.system.startsWith(PROMPT)).toBe(true);
      expect(request.system).toMatch(/wrote their last message in English\. Write your reply in English/);
      expect(request.messages[0]).toEqual({ role: "user", content: "pay the cleaner for September, please" });
    }
    // What the model reads last before it answers: a user-role tool result, in Portuguese.
    const last = sent[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("mensalidade outubro");
  });

  it("a Portuguese turn states Brazilian Portuguese", async () => {
    const sent = await oneTurn("pague a escola de outubro");
    for (const request of sent) expect(request.system).toMatch(/wrote their last message in Brazilian Portuguese\. Write your reply in Brazilian Portuguese/);
  });

  it("a turn whose language cannot be read adds nothing, and the prompt's own default stands", async () => {
    const sent = await oneTurn("ok");
    for (const request of sent) expect(request.system).toBe(PROMPT);
  });
});
