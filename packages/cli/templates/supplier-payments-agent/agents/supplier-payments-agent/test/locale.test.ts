/**
 * #64 on the batch gesture: one question for a whole list, shown in the run's
 * locale and read the same in both. For every answer the parser has a rule
 * for, in either language, the pt-BR run and the English run veto the same
 * lines, pay the same lines, and record the same gesture.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock, type Locale } from "@codespar/agent-core";
import { handleExecution, presentBatch, setup, type BatchGestures, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { runBatch } from "../src/modules/batch-payout.js";
import { findBatch } from "../src/payables.js";

const APPROVER = { id: "usr_demo_financeiro", channel: "terminal" };

function open(locale: Locale): Setup {
  return setup(agent, {
    mode: "human",
    rail: "stub",
    provider: "replay",
    runsDir: mkdtempSync(join(tmpdir(), "supplier-locale-runs-")),
    stateDir: mkdtempSync(join(tmpdir(), "supplier-locale-state-")),
    now: fixedClock("2026-09-23T14:00:00-03:00"),
    say: () => undefined,
    locale,
  });
}

/** Runs the October payroll through the interactive terminal's two hooks, answering the list question with `answers` in order. */
async function gesture(locale: Locale, answers: string[]) {
  const s = open(locale);
  const asked: string[] = [];
  const said: string[] = [];
  const queue = [...answers];
  const gestures: BatchGestures = new Map();
  const options = {
    setup: s,
    approver: APPROVER,
    gestures,
    say: (l: string) => void said.push(l),
    ask: async (q: string) => {
      asked.push(q);
      const next = queue.shift();
      if (next === undefined) throw new Error(`asked more than scripted: ${q}`);
      return next;
    },
  };
  try {
    const report = await runBatch(findBatch("folha-2026-10")!, {
      engine: s.engine,
      onExecution: (execution) => handleExecution(execution, options),
      onBatch: (batch) => presentBatch(batch, options),
    });
    const recorded = s.bundle.readEvents().filter((e) => e["type"] === "batch.gesture").map((e) => {
      const { approved, vetoed, count, total_minor } = e["payload"] as Record<string, unknown>;
      return { approved, vetoed, count, total_minor };
    });
    return { dispatch: report.lines.map((l) => l.dispatch), gesture: report.gesture, recorded, asked, said, settled: report.settled_minor };
  } finally {
    s.close();
  }
}

const ANSWERS: string[][] = [["todas"], ["all"], ["todas exceto 2"], ["all except 2"], ["todas exceto 1, 3"], ["all except 3,1"], ["nenhuma"], ["none"], [""], ["nao"], ["tudo", "all"], ["everything", "todas exceto 3"]];

describe("the batch gesture decides the same in both locales", () => {
  it.each(ANSWERS)("answers %j", async (...answers) => {
    const pt = await gesture("pt-BR", answers);
    const en = await gesture("en", answers);
    // The question is shown in the run's locale...
    expect(new Set(pt.asked)).toEqual(new Set(["  Aprovar a lista? [todas / todas exceto 3,7 / nenhuma] "]));
    expect(new Set(en.asked)).toEqual(new Set(["  Approve the list? [all / all except 3,7 / none] "]));
    expect(en.asked).toHaveLength(pt.asked.length);
    // ...and the answer decides the same lines either way.
    expect(en.dispatch).toEqual(pt.dispatch);
    expect(en.gesture).toEqual({ ...pt.gesture, batch_hash: en.gesture!.batch_hash });
    expect(en.gesture!.batch_hash).toBe(pt.gesture!.batch_hash);
    expect(en.recorded).toEqual(pt.recorded);
    expect(en.settled).toBe(pt.settled);
  });

  it("shows the list and the outcome in the run's locale, amounts formatted for its reader", async () => {
    const pt = await gesture("pt-BR", ["todas exceto 2"]);
    const en = await gesture("en", ["todas exceto 2"]);
    expect(pt.said.join("\n")).toMatch(/lote folha-2026-10 — .*: 3 linha\(s\), total R\$ 5\.400,00/);
    expect(pt.said).toContain("  -> lista aprovada exceto 2");
    expect(en.said.join("\n")).toMatch(/batch folha-2026-10 — .*: 3 line\(s\), total R\$5,400\.00/);
    expect(en.said).toContain("  -> list approved except 2");
  });

  it("asks again, in its own language, when the answer cannot be read", async () => {
    const pt = await gesture("pt-BR", ["talvez", "todas"]);
    const en = await gesture("en", ["maybe", "all"]);
    expect(pt.said).toContain("  não entendi; responda todas, todas exceto <números de 1 a 3> ou nenhuma");
    expect(en.said).toContain("  I did not understand; answer all, all except <numbers from 1 to 3> or none");
    expect(en.dispatch).toEqual(pt.dispatch);
  });
});
