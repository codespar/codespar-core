import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenario, listScenarios, loadScenario, runScenario, type ScenarioRun } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const runsDir = mkdtempSync(join(tmpdir(), "bills-runs-"));

describe("section 12: scenario packs, on the replay provider", () => {
  const required = ["happy-path", "cap-exceeded", "beneficiary-not-allowed", "prompt-injection", "escalated-above-threshold", "mandate-revoked"];

  it("ships every scenario the spec asks for", () => {
    for (const name of required) expect(listScenarios(agent)).toContain(name);
  });

  for (const name of required) {
    const scenario = loadScenario(agent, name);
    for (const mode of scenario.modes) {
      it(`${name} [${mode}] ends in the states the pack declares`, async () => {
        const run = await runScenario(agent, scenario, { mode, runsDir });
        const check = checkScenario(scenario, run);
        expect(check.failures).toEqual([]);
        expect(check.ok).toBe(true);
        // Every event of the bundle carries an actor.
        const events = readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { actor?: unknown });
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) expect(e.actor).toBeDefined();
        // Every receipt carries an actor and no raw payee.
        for (const file of readdirSync(join(run.bundle_dir, "receipts"))) {
          const receipt = JSON.parse(readFileSync(join(run.bundle_dir, "receipts", file), "utf8")) as { actor?: unknown; payment: { payee: string | null } };
          expect(receipt.actor).toBeDefined();
          expect(receipt.payment.payee ?? "").toContain("***");
        }
      });
    }
  }

  it("happy-path: the same trail and the same receipts in human and in mandate", async () => {
    const scenario = loadScenario(agent, "happy-path");
    const human = await runScenario(agent, scenario, { mode: "human", runsDir });
    const mandate = await runScenario(agent, scenario, { mode: "mandate", runsDir });
    expect(human.executions.map((e) => e.trail)).toEqual(mandate.executions.map((e) => e.trail));
    expect(normalizeReceipts(human)).toEqual(normalizeReceipts(mandate));
    // In human, the artifact is a person's; in mandate the person still decided because the amount escalated.
    const approvals = (run: ScenarioRun) => JSON.parse(readFileSync(join(run.bundle_dir, "approval.json"), "utf8")) as Array<{ approver: { type: string }; items_hash: string; escalation?: { trigger: string } }>;
    expect(approvals(human)[0]?.approver.type).toBe("person");
    expect(approvals(mandate)[0]?.approver.type).toBe("person");
    expect(approvals(mandate)[0]?.escalation?.trigger).toBe("amount");
    expect(approvals(human)[0]?.items_hash).toBe(approvals(mandate)[0]?.items_hash);
  });

  it("nothing reaches executing without an approval artifact carrying its items_hash", async () => {
    for (const name of required) {
      const scenario = loadScenario(agent, name);
      for (const mode of scenario.modes) {
        const run = await runScenario(agent, scenario, { mode, runsDir });
        const approvalPath = join(run.bundle_dir, "approval.json");
        const artifacts = existsSync(approvalPath) ? (JSON.parse(readFileSync(approvalPath, "utf8")) as Array<{ execution_id: string; items_hash: string }>) : [];
        for (const e of run.executions) {
          if (!e.trail.includes("executing")) continue;
          expect(artifacts.some((a) => a.execution_id === e.id)).toBe(true);
        }
      }
    }
  });
});

function normalizeReceipts(run: ScenarioRun): unknown[] {
  return readdirSync(join(run.bundle_dir, "receipts"))
    .map((f) => JSON.parse(readFileSync(join(run.bundle_dir, "receipts", f), "utf8")) as { state: string; mandate: { id: string }; payment: { amount_minor: number; payee: string | null; sandbox: boolean } })
    .map((r) => ({ state: r.state, mandate: r.mandate.id, amount: r.payment.amount_minor, payee: r.payment.payee, sandbox: r.payment.sandbox }))
    .sort((a, b) => a.amount - b.amount);
}
