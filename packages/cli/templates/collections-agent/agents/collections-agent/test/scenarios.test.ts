import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGREEMENTS } from "../src/agreements.js";
import { checkScenario, listScenarios, loadScenario, runScenario, type ScenarioRun } from "../src/scenarios.js";

const runsDir = mkdtempSync(join(tmpdir(), "collections-runs-"));
const DOCUMENTS = AGREEMENTS.map((a) => a.document);

describe("section 12: scenario packs, on the replay provider and the stub rail", () => {
  const required = ["happy-path", "charge-expired", "prompt-injection", "cap-exceeded", "beneficiary-not-allowed", "escalated-above-threshold", "mandate-revoked", "instalments"];

  it("ships every scenario the spec asks for, plus instalments", () => {
    for (const name of required) expect(listScenarios()).toContain(name);
  });

  for (const name of required) {
    const scenario = loadScenario(name);
    for (const mode of scenario.modes) {
      it(`${name} [${mode}] ends in the states the pack declares`, async () => {
        const run = await runScenario(scenario, { mode, runsDir });
        const check = checkScenario(scenario, run);
        expect(check.failures).toEqual([]);
        expect(check.ok).toBe(true);
        // Every event of the bundle carries an actor; no event carries a debtor's document in the clear.
        const raw = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8");
        const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { actor?: unknown; type: string });
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) expect(e.actor).toBeDefined();
        // Every record carries an actor and no raw document; the snapshot masks the book.
        for (const file of readdirSync(join(run.bundle_dir, "receipts"))) {
          const receipt = JSON.parse(readFileSync(join(run.bundle_dir, "receipts", file), "utf8")) as { actor?: unknown; kind?: string; chain: string | null; payment: { payee: string | null; money_moved: boolean; sandbox: boolean } };
          expect(receipt.actor).toBeDefined();
          expect(receipt.kind).toBe("charge");
          expect(receipt.chain).toBeNull();
          expect(receipt.payment.money_moved).toBe(false);
          expect(receipt.payment.sandbox).toBe(true);
          expect(receipt.payment.payee ?? "").toContain("***");
        }
        const snapshot = readFileSync(join(run.bundle_dir, "mandate.snapshot.json"), "utf8");
        for (const doc of DOCUMENTS) expect(snapshot).not.toContain(doc);
      });
    }
  }

  it("happy-path: the same records in human and in mandate; the person decided in human, the envelope in mandate", async () => {
    const scenario = loadScenario("happy-path");
    const human = await runScenario(scenario, { mode: "human", runsDir });
    const mandate = await runScenario(scenario, { mode: "mandate", runsDir });
    expect(normalizeReceipts(human)).toEqual(normalizeReceipts(mandate));
    const approvals = (run: ScenarioRun) => JSON.parse(readFileSync(join(run.bundle_dir, "approval.json"), "utf8")) as Array<{ approver: { type: string }; items_hash: string; items: Array<{ due_date?: string }> }>;
    expect(approvals(human)[0]?.approver.type).toBe("person");
    expect(approvals(mandate)[0]?.approver.type).toBe("mandate");
    expect(approvals(human)[0]?.items_hash).toBe(approvals(mandate)[0]?.items_hash);
    expect(approvals(human)[0]?.items[0]?.due_date).toBe("2026-09-30");
    // The payer saw the instrument once and was told once, in each mode.
    for (const run of [human, mandate]) {
      const events = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload?: { payable?: boolean } });
      expect(events.filter((e) => e.type === "charge.instrument" && e.payload?.payable === true)).toHaveLength(1);
      expect(events.filter((e) => e.type === "message.debtor")).toHaveLength(1);
      expect(events.filter((e) => e.type === "commerce.charge.paid")).toHaveLength(1);
    }
  });

  it("nothing reaches executing without an approval artifact carrying its items_hash", async () => {
    for (const name of required) {
      const scenario = loadScenario(name);
      for (const mode of scenario.modes) {
        const run = await runScenario(scenario, { mode, runsDir });
        const approvalPath = join(run.bundle_dir, "approval.json");
        const artifacts = existsSync(approvalPath) ? (JSON.parse(readFileSync(approvalPath, "utf8")) as Array<{ execution_id: string; items_hash: string }>) : [];
        for (const e of run.executions) {
          if (!e.trail.includes("executing")) continue;
          expect(artifacts.some((a) => a.execution_id === e.id)).toBe(true);
        }
      }
    }
  });

  it("instalments: three receivables, three idempotency keys, one execution, one message", async () => {
    const run = await runScenario(loadScenario("instalments"), { mode: "human", runsDir });
    expect(run.executions).toHaveLength(1);
    expect(new Set(run.executions[0]!.charge_ids).size).toBe(3);
    expect(run.charges_issued).toBe(3);
    expect(run.debtor_messages).toBe(1);
  });
});

function normalizeReceipts(run: ScenarioRun): unknown[] {
  return readdirSync(join(run.bundle_dir, "receipts"))
    .map((f) => JSON.parse(readFileSync(join(run.bundle_dir, "receipts", f), "utf8")) as { state: string; kind?: string; payment: { amount_minor: number; payee: string | null; sandbox: boolean } })
    .map((r) => ({ state: r.state, kind: r.kind, amount: r.payment.amount_minor, payee: r.payment.payee, sandbox: r.payment.sandbox }))
    .sort((a, b) => a.amount - b.amount);
}
