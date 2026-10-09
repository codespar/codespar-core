/**
 * Issue #60 on the one-off payment: `codespar_pay` says `paid: true` only for
 * a payment this call made. A bill's attempt id comes from its own execution,
 * so the rail cannot replay one at dispatch today; the rail is scripted to
 * answer the way the API answers a repeat, so the report is pinned before
 * anything makes that reachable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock, type Execution, type StubRail, type ToolContext } from "@codespar/agent-core";
import { setup, type Setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { codesparPay } from "../src/modules/pix-out.js";

const APPROVER = { id: "usr_demo", channel: "terminal" };

function open(): Setup {
  return setup(agent, {
    mode: "human",
    rail: "stub",
    provider: "replay",
    runsDir: mkdtempSync(join(tmpdir(), "bills-replay-runs-")),
    stateDir: mkdtempSync(join(tmpdir(), "bills-replay-state-")),
    now: fixedClock("2026-09-23T14:00:00-03:00"),
    say: () => undefined,
  });
}

function context(s: Setup): ToolContext {
  return {
    engine: s.engine,
    onExecution: async (execution: Execution) => {
      let current = execution;
      if (current.state === "awaiting_approval") current = s.engine.approve(current.id, APPROVER);
      if (current.state === "approved") current = await s.engine.execute(current.id);
      return current;
    },
  };
}

const PIX = { action: "pix", items: [{ payee: "mercado", amount_minor: 64000, description: "compras da semana" }] };

describe("codespar_pay: a settlement this call did not make is not reported as paid (#60)", () => {
  it("a payment this call made is paid, and not replayed", async () => {
    const s = open();
    try {
      const result = await codesparPay(PIX, context(s));
      expect(result).toMatchObject({ status: "settled", paid: true, replayed: false });
    } finally {
      s.close();
    }
  });

  it("a payment the rail answered from an earlier presentation is settled, replayed, and not paid by this call", async () => {
    const s = open();
    try {
      const rail = s.rail as StubRail;
      const pay = rail.pay.bind(rail);
      rail.pay = async (payment) => {
        const outcome = await pay(payment);
        return outcome.status === "settled" ? { ...outcome, replayed: true } : outcome;
      };
      const result = (await codesparPay(PIX, context(s))) as { status: string; paid: boolean; replayed: boolean; receipt_ids: string[] };
      expect(result).toMatchObject({ status: "settled", paid: false, replayed: true });
      expect(result.receipt_ids).toHaveLength(1);

      const oneShot = agent.kit.oneShotPayload({ setup: s, reply: "", toolCalls: [], executions: s.engine.list(), startedAt: 0 }) as { executions: Array<{ state: string; replayed: boolean }> };
      expect(oneShot.executions).toEqual([expect.objectContaining({ state: "settled", replayed: true })]);
      expect(agent.kit.describeExecution(s.engine.list()[0]!, s).join("\n")).toContain("esta execução não moveu dinheiro");
    } finally {
      s.close();
    }
  });
});
