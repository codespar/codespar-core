/**
 * The sandbox payer in the poll pays a receivable only once it is payable.
 * It used to also pay "after a few looks", whatever it found, and on staging
 * that paid a charge the issuer had ended in ERROR: the order read `settled`
 * with no QR ever shown (OPEN_QUESTIONS §63, ent#1816). These drive the poll
 * with a rail that stays unpayable for longer than the old patience.
 */
import { describe, expect, it } from "vitest";
import type { ChargeInstrument, Execution, ExecutionEngine } from "@codespar/agent-core";
import { pollUntilClosed } from "../src/poll.js";

function instrument(payable: boolean): ChargeInstrument {
  return { payable, status: payable ? "PENDING" : "PROCESSING", pix_copy_paste: payable ? "000201..." : null, boleto_bank_line: payable ? "2".repeat(47) : null, boleto_bar_code: null, due_date: "2026-09-30" };
}

/** An engine that answers one executing receivable, payable from look `payableFrom` on (never when undefined). */
function engineWith(payableFrom?: number) {
  let looks = 0;
  const execution = (): Execution =>
    ({
      id: "exe_1",
      state: "executing",
      outcomes: [{ index: 0, attempt_id: "att_1_0", status: "accepted", transaction_id: "chg_1", instrument: instrument(payableFrom !== undefined && looks >= payableFrom) }],
    }) as unknown as Execution;
  const engine = {
    get: () => execution(),
    reconcile: async () => ((looks += 1), execution()),
    markShown: () => true,
    note: () => undefined,
  } as unknown as ExecutionEngine;
  return { engine, looks: () => looks };
}

function payerSpy() {
  const calls: string[] = [];
  return {
    calls,
    payer: {
      kind: "stub" as const,
      pay: async (chargeId: string) => (calls.push(chargeId), { ok: true as const, detail: "paid" }),
      behave: () => undefined,
    },
  };
}

describe("the poll's sandbox payer pays only what is payable", () => {
  it("a receivable that never becomes payable is never paid, however many looks the wait allows", async () => {
    const { engine, looks } = engineWith(undefined);
    const { payer, calls } = payerSpy();
    const result = await pollUntilClosed(engine, "exe_1", { intervalMs: 0, timeoutMs: 0, maxRounds: 12, payer });
    expect(looks()).toBe(12);
    expect(calls).toEqual([]);
    expect(result.payer_calls).toEqual([]);
    expect(result.timed_out).toBe(true);
  });

  it("the payer plays once, on the first look that finds it payable", async () => {
    const { engine } = engineWith(7);
    const { payer, calls } = payerSpy();
    const result = await pollUntilClosed(engine, "exe_1", { intervalMs: 0, timeoutMs: 0, maxRounds: 12, payer });
    expect(calls).toEqual(["chg_1"]);
    expect(result.payer_calls).toEqual(["paid"]);
  });
});
