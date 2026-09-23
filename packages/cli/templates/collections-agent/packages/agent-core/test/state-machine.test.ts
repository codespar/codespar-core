import { describe, expect, it } from "vitest";
import { canTransition, IllegalTransitionError, isTerminal, transition, TRANSITIONS, type Execution } from "../src/state-machine.js";
import type { Actor } from "../src/types.js";

const actor: Actor = { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_test" };

function drafted(): Execution<"drafted"> {
  return {
    id: "exe_1",
    run_id: "run_1",
    state: "drafted",
    mode: "human",
    actor,
    items: [],
    total: 0,
    currency: "BRL",
    items_hash: "sha256:x",
    mandate: { id: "mdt_1", version: 1 },
    idempotency_key: "idk_1",
    blocking_reasons: [],
    outcomes: [],
    history: [],
    created_at: "2026-09-23T10:00:00.000Z",
    updated_at: "2026-09-23T10:00:00.000Z",
  };
}

describe("section 4.1: closed state machine", () => {
  it("has exactly the table of the spec plus the 4.2 return and the 4.7 exits", () => {
    expect(TRANSITIONS).toEqual({
      drafted: ["awaiting_approval", "approved", "denied", "expired"],
      awaiting_approval: ["approved", "denied", "expired"],
      approved: ["executing", "awaiting_approval", "denied", "expired"],
      executing: ["settled", "failed"],
      settled: [],
      failed: [],
      denied: [],
      expired: [],
    });
  });

  it("walks the happy path and appends every step to history", () => {
    const at = "2026-09-23T10:01:00.000Z";
    const a = transition(drafted(), "awaiting_approval", { at, actor });
    const b = transition(a, "approved", { at, actor });
    const c = transition(b, "executing", { at, actor });
    const d = transition(c, "settled", { at, actor });
    expect(d.state).toBe("settled");
    expect(d.history.map((h) => h.to)).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(isTerminal(d.state)).toBe(true);
  });

  it("refuses a transition outside the table at runtime even when the types were bypassed", () => {
    const settled = { ...drafted(), state: "settled" as const };
    expect(() => transition(settled as unknown as Execution<"drafted">, "awaiting_approval", { at: "x", actor })).toThrow(IllegalTransitionError);
    expect(canTransition("executing", "denied")).toBe(false);
    expect(canTransition("drafted", "executing")).toBe(false);
    expect(canTransition("settled", "failed")).toBe(false);
  });

  it("terminal states have no exits", () => {
    for (const s of ["settled", "failed", "denied", "expired"] as const) {
      expect(TRANSITIONS[s]).toEqual([]);
      expect(isTerminal(s)).toBe(true);
    }
  });
});
