/**
 * #50: the line a person reads after an execution moves carries the rail's own
 * code and message, verbatim, after the reason — on a failure and on an answer
 * that left an attempt unknown — and nothing more when there is none.
 */
import type { Execution } from "@codespar/agent-core";
import { describe, expect, it } from "vitest";
import { transitionLine } from "../src/terminal.js";

function execution(over: Partial<Execution>): Execution {
  return { state: "settled", outcomes: [], ...over } as Execution;
}

describe("transitionLine", () => {
  it("a failure: the reason, then the API's code and message", () => {
    const failed = execution({ state: "failed", reason: "rail_failed", outcomes: [{ index: 0, attempt_id: "att_0", status: "failed", code: "insufficient_funds", message: "wallet cannot reserve the requested amount" }] });
    expect(transitionLine(failed)).toBe("  -> failed (rail_failed): insufficient_funds — wallet cannot reserve the requested amount");
  });

  it("an unknown outcome: the reason, then what the API answered", () => {
    const open = execution({ state: "executing", reason: "rail_uncertain", uncertain_answers: [{ attempt_id: "att_0", code: "provider_error", message: "no receiving identity" }] });
    expect(transitionLine(open)).toBe("  -> executing (rail_uncertain): provider_error — no receiving identity");
  });

  it("nothing to add when nothing failed", () => {
    expect(transitionLine(execution({ state: "settled" }))).toBe("  -> settled");
    expect(transitionLine(execution({ state: "denied", reason: "cap_exceeded" as Execution["reason"] }))).toBe("  -> denied (cap_exceeded)");
  });
});
