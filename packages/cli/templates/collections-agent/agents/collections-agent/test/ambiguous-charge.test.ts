/**
 * An issued receivable whose reference turned ambiguous (`charge_reference_ambiguous`)
 * may still be paid. The agent must not report the agreement as open, must not tell the
 * debtor nothing was charged, and must not issue a second charge for the same debt.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Execution } from "@codespar/agent-core";
import { announceOutcome, setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

describe("a receivable closed charge_reference_ambiguous: reconcile, never reissue", () => {
  it("list_agreements does not reopen it, a new charge for it is refused before the rail, and the debtor is not told nothing was charged", async () => {
    let clock = new Date("2026-09-23T18:00:00Z");
    const s = setup(agent, { mode: "mandate", rail: "stub", provider: "replay", transcript: "unused", stateDir: mkdtempSync(join(tmpdir(), "collections-ambiguous-")), runsDir: mkdtempSync(join(tmpdir(), "collections-ambiguous-runs-")), now: () => (clock = new Date(clock.getTime() + 1000)), say: () => undefined });
    try {
      s.payer!.behave("never");
      const d = await s.engine.draft({ items: [{ payee: "acordo-1042", amount: 108000, due_date: "2026-09-30" }] });
      if (!d.ok) throw new Error("refused");
      const issued = await s.engine.execute(d.execution.id);
      expect(issued.state).toBe("executing");
      // The stub rail cannot answer 409; the core's own test drives that read. Here the closed execution is what the agent reads.
      const chargeId = issued.outcomes[0]!.transaction_id!;
      const closed: Execution = {
        ...issued,
        state: "failed",
        reason: "charge_reference_ambiguous",
        detail: "charge_reference_ambiguous: the reference matches more than one charge",
        outcomes: [{ index: 0, attempt_id: issued.outcomes[0]!.attempt_id, status: "failed", code: "charge_reference_ambiguous", error: "charge_reference_ambiguous" }],
        history: [...issued.history, { from: "executing", to: "failed", at: clock.toISOString(), actor: issued.actor, reason: "charge_reference_ambiguous" }],
      };
      s.store.saveExecution(closed);

      const handlers = s.kit.handlers(s);
      const ctx = { engine: s.engine, onExecution: async (e: Execution) => e };
      const listed = (await handlers["list_agreements"]!({}, ctx)) as { agreements: Array<{ alias: string; status: string }> };
      expect(listed.agreements.find((a) => a.alias === "acordo-1042")?.status).toBe("cobranca emitida, em conferencia: nao emitir outra");

      const again = (await handlers["codespar_charge"]!({ action: "create", agreement: "acordo-1042", instalments: [{ amount_minor: 108000, due_date: "2026-10-15" }] }, ctx)) as Record<string, unknown>;
      expect(again).toMatchObject({ status: "denied", reason: "charge_reference_ambiguous", issued: false, charges: [] });
      expect(s.engine.list({ state: "executing" })).toHaveLength(0);
      expect(s.engine.list().flatMap((e) => e.outcomes).filter((o) => o.transaction_id && o.transaction_id !== chargeId)).toEqual([]);

      const told: string[] = [];
      announceOutcome(closed, s, (l) => told.push(l));
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("ja foi emitida");
      expect(told[0]).not.toContain("Nada foi cobrado");
    } finally {
      s.close();
    }
  });
});
