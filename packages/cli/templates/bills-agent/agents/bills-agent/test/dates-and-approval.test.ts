/**
 * What the first real-model runs showed (docs/OPEN_QUESTIONS.md §64): with no
 * date of its own, the model called a bill due next week "venceu dia 05"; told
 * both approval modes exist and not which one ran, it said a payment the
 * titular approved needed "no extra approval". The tools now carry both facts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daysUntil, fixedClock, localDate, type Execution, type ToolContext } from "@codespar/agent-core";
import { setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { codesparPay, listBills } from "../src/modules/pix-out.js";

function open(mode: "human" | "mandate", now: string): Setup {
  return setup(agent, {
    mode,
    rail: "stub",
    provider: "replay",
    runsDir: mkdtempSync(join(tmpdir(), "bills-dates-runs-")),
    stateDir: mkdtempSync(join(tmpdir(), "bills-dates-state-")),
    now: fixedClock(now),
    say: () => undefined,
  });
}

function context(s: Setup, decide: boolean): ToolContext {
  return {
    engine: s.engine,
    onExecution: async (execution: Execution) => {
      let current = execution;
      if (decide && current.state === "awaiting_approval") current = s.engine.approve(current.id, { id: "usr_demo", channel: "terminal" });
      if (current.state === "approved") current = await s.engine.execute(current.id);
      return current;
    },
  };
}

describe("the calendar the model reads", () => {
  it("localDate is the day in the timezone, not in UTC", () => {
    // 23:30 in Sao Paulo on the 28th is already the 29th in UTC.
    expect(localDate(new Date("2026-09-29T02:30:00Z"), "America/Sao_Paulo")).toBe("2026-09-28");
    expect(localDate(new Date("2026-09-29T02:30:00Z"), "UTC")).toBe("2026-09-29");
  });

  it("daysUntil counts whole days, negative once past", () => {
    expect(daysUntil("2026-09-28", "2026-10-05")).toBe(7);
    expect(daysUntil("2026-10-05", "2026-10-05")).toBe(0);
    expect(daysUntil("2026-10-06", "2026-10-05")).toBe(-1);
  });

  it("list_bills carries today, from the pinned clock, and days_until_due per bill", async () => {
    const s = open("human", "2026-09-28T14:00:00-03:00");
    try {
      const out = (await listBills({}, context(s, false))) as { today: string; bills: Array<{ alias: string; due: string; days_until_due: number }> };
      expect(out.today).toBe("2026-09-28");
      const mercado = out.bills.find((b) => b.alias === "mercado")!;
      expect(mercado.due).toBe("2026-10-05");
      expect(mercado.days_until_due).toBe(7);
    } finally {
      s.close();
    }
  });
});

describe("codespar_pay says who approved, so the model does not guess", () => {
  const PIX = { action: "pix", items: [{ payee: "mercado", amount_minor: 64000 }] };

  it("a person's approval is `human`", async () => {
    const s = open("human", "2026-09-28T14:00:00-03:00");
    try {
      expect(await codesparPay(PIX, context(s, true))).toMatchObject({ status: "settled", approved_by: "human" });
    } finally {
      s.close();
    }
  });

  it("nobody has approved an execution still waiting: `null`", async () => {
    const s = open("human", "2026-09-28T14:00:00-03:00");
    try {
      expect(await codesparPay(PIX, context(s, false))).toMatchObject({ status: "awaiting_approval", approved_by: null });
    } finally {
      s.close();
    }
  });

  it("the signed allowance's approval is `mandate`", async () => {
    const s = open("mandate", "2026-09-28T14:00:00-03:00");
    try {
      // Warm the payee so `new_beneficiary` does not send it to a person.
      await s.kit.warmUp!(s, ["mercado"], { id: "usr_demo", channel: "terminal" });
      expect(await codesparPay(PIX, context(s, false))).toMatchObject({ status: "settled", approved_by: "mandate" });
    } finally {
      s.close();
    }
  });
});
