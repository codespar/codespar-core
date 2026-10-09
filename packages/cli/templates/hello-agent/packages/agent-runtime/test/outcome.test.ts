/**
 * The count the terminal prints and the one-shot exits by, on the cases a
 * process test cannot stage cheaply: which reasons read as declined, and
 * which exit code wins.
 */
import { describe, expect, it } from "vitest";
import { isDeclinedReason, type Execution, type NotRunLine } from "@codespar/agent-core";
import { outcomeExitCode, runOutcome } from "../src/outcome.js";

function execution(state: Execution["state"], over: Partial<Pick<Execution, "reason" | "outcomes">> = {}): Execution {
  return { id: `exec_${Math.random().toString(36).slice(2)}`, state, outcomes: [], ...over } as unknown as Execution;
}

const outcome = (status: "settled" | "failed" | "accepted", over: Record<string, unknown> = {}) => ({ index: 0, attempt_id: "att", status, ...over }) as Execution["outcomes"][number];

describe("isDeclinedReason", () => {
  it("is true of a charge nobody paid, a charge withdrawn and the organization's pause, and of nothing else", () => {
    for (const reason of ["charge_expired", "charge_cancelled", "org_paused"]) expect(isDeclinedReason(reason)).toBe(true);
    for (const reason of ["charge_issuer_error", "rail_failed", "psp_dispatch_failed", undefined, null]) expect(isDeclinedReason(reason)).toBe(false);
  });
});

describe("runOutcome", () => {
  it("counts a multi-item execution by payment: three paid and one failed", () => {
    const e = execution("failed", { reason: "rail_failed", outcomes: [outcome("settled"), outcome("failed", { code: "psp_dispatch_failed" }), outcome("settled"), outcome("settled")] });
    expect(runOutcome([e], [])).toEqual({ settled: 3, failed: 1, declined: 0, already_paid: 0, open: 0 });
  });

  it("counts a replayed settlement as already paid, attempt by attempt", () => {
    const e = execution("settled", { outcomes: [outcome("settled", { replayed: true }), outcome("settled")] });
    expect(runOutcome([e], [])).toMatchObject({ settled: 1, already_paid: 1 });
  });

  it("reads charge_expired, charge_cancelled and org_paused as declined, and charge_issuer_error as failed", () => {
    const declined = ["charge_expired", "charge_cancelled", "org_paused"].map((code) => execution("failed", { reason: code as Execution["reason"], outcomes: [outcome("failed", { code })] }));
    expect(runOutcome(declined, [])).toEqual({ settled: 0, failed: 0, declined: 3, already_paid: 0, open: 0 });
    expect(runOutcome([execution("failed", { reason: "charge_issuer_error", outcomes: [outcome("failed", { code: "charge_issuer_error" })] })], [])).toMatchObject({ failed: 1, declined: 0 });
  });

  it("reads an execution closed with no attempt by its own reason", () => {
    expect(runOutcome([execution("failed", { reason: "org_paused" }), execution("failed", { reason: "rail_failed" }), execution("denied"), execution("expired")], [])).toEqual({ settled: 0, failed: 1, declined: 3, already_paid: 0, open: 0 });
  });

  it("counts a line an earlier run holds as open, whatever that run's verdict, and a refused line as failed", () => {
    const notRun: NotRunLine[] = [
      { ref: "a", why: "in_progress", detail: "attempt_id_conflict" },
      { ref: "b", why: "in_progress", detail: "in_progress" },
      { ref: "c", why: "already_settled" },
      { ref: "d", why: "refused", detail: "unreadable_line" },
    ];
    expect(runOutcome([], notRun)).toEqual({ settled: 0, failed: 1, declined: 0, already_paid: 1, open: 2 });
  });
});

describe("outcomeExitCode", () => {
  const executing = execution("executing");

  it("1 wins over 3: something failed and something else was left executing", () => {
    const failed = execution("failed", { reason: "rail_failed", outcomes: [outcome("failed")] });
    const counted = runOutcome([failed, executing], []);
    expect(counted).toMatchObject({ failed: 1, open: 1 });
    expect(outcomeExitCode(counted, [failed, executing])).toBe(1);
  });

  it("3 when nothing failed and an execution of this run was left executing", () => {
    expect(outcomeExitCode(runOutcome([executing], []), [executing])).toBe(3);
  });

  it("0 when a line is held by an earlier run and this run left nothing executing", () => {
    expect(outcomeExitCode(runOutcome([], [{ ref: "a", why: "in_progress" }]), [])).toBe(0);
  });
});
