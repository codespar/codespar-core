/**
 * `notReplayed` reads a bundle's events for what only the world can do. These
 * are the events as the engine writes them, by hand, so the reading is held
 * to the shape and not to whatever a scenario happens to produce.
 */
import { describe, expect, it } from "vitest";
import { notReplayed } from "../src/commands/rerun.js";

const transition = (execution: string, to: string, reason?: string) => ({ type: "execution.transition", execution_id: execution, payload: { to, ...(reason ? { reason } : {}) } });
const outcome = (execution: string, status: string) => ({ type: "rail.outcome", execution_id: execution, payload: { status } });

describe("what a rerun does not replay", () => {
  it("nothing, in a run that settled, failed on the rail or was denied by a person", () => {
    expect(notReplayed([transition("a", "approved"), transition("a", "executing"), outcome("a", "settled"), transition("a", "settled")])).toEqual([]);
    expect(notReplayed([transition("a", "executing"), outcome("a", "failed"), transition("a", "failed", "rail_failed")])).toEqual([]);
    expect(notReplayed([transition("a", "awaiting_approval"), transition("a", "denied", "denied_by_approver")])).toEqual([]);
    // A reason that is a key of every object is not one of the three this reads.
    expect(notReplayed([transition("a", "denied", "constructor"), transition("b", "denied", "toString")])).toEqual([]);
    // Left awaiting approval is the person not deciding, and a rerun does replay that.
    expect(notReplayed([transition("a", "awaiting_approval")])).toEqual([]);
  });

  it("a mandate revoked or paused, and the organization's kill switch, at a gate or before a draft", () => {
    expect(notReplayed([transition("a", "denied", "mandate_revoked")])).toEqual(["a mandate that was revoked"]);
    expect(notReplayed([transition("a", "denied", "mandate_paused")])).toEqual(["a mandate that was paused"]);
    expect(notReplayed([transition("a", "denied", "org_paused")])).toEqual(["an organization that paused every mandate"]);
    expect(notReplayed([{ type: "execution.refused_before_draft", execution_id: null, payload: { reason: "mandate_revoked" } }])).toEqual(["a mandate that was revoked"]);
  });

  it("an uncertain answer from the rail, even one a later reconciliation settled", () => {
    expect(notReplayed([transition("a", "executing"), outcome("a", "uncertain"), transition("a", "settled")])).toEqual(["an uncertain answer from the rail"]);
    // Whichever of the engine's three events for it the bundle holds.
    expect(notReplayed([{ type: "rail.uncertain", execution_id: "a", payload: {} }])).toEqual(["an uncertain answer from the rail"]);
    expect(notReplayed([{ type: "execution.uncertain", execution_id: "a", payload: { detail: "attempt att_1: psp_dispatch_uncertain" } }])).toEqual(["an uncertain answer from the rail"]);
  });

  it("a charge issued and still out when the run ended, and not one that was paid", () => {
    expect(notReplayed([transition("a", "executing"), outcome("a", "accepted")])).toEqual(["a payer who had not paid when it ended"]);
    expect(notReplayed([transition("a", "executing"), outcome("a", "accepted"), transition("a", "settled")])).toEqual([]);
  });

  it("each thing once, in the order the run met them", () => {
    const events = [transition("a", "executing"), outcome("a", "uncertain"), transition("b", "denied", "mandate_revoked"), { type: "execution.refused_before_draft", execution_id: null, payload: { reason: "mandate_revoked" } }];
    expect(notReplayed(events)).toEqual(["an uncertain answer from the rail", "a mandate that was revoked"]);
  });
});
