import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenario, listScenarios, loadScenario, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const runsDir = mkdtempSync(join(tmpdir(), "supplier-runs-"));

describe("section 12: scenario packs, on the replay provider", () => {
  const required = ["happy-path", "partial-batch-failure", "cap-exceeded", "beneficiary-not-allowed", "prompt-injection", "escalated-above-threshold", "mandate-revoked"];

  it("ships every scenario the spec asks for, including this agent's own", () => {
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

  it("happy-path: the batch is three executions and three artifacts, in both modes", async () => {
    const scenario = loadScenario(agent, "happy-path");
    for (const mode of ["human", "mandate"] as const) {
      const run = await runScenario(agent, scenario, { mode, runsDir });
      expect(run.executions).toHaveLength(3);
      const artifacts = JSON.parse(readFileSync(join(run.bundle_dir, "approval.json"), "utf8")) as Array<{ execution_id: string; items: unknown[]; items_hash: string; approver: { type: string } }>;
      expect(artifacts).toHaveLength(3);
      // The approved list is attested line by line: one item per artifact, one hash each, and a person decided every one. The set they belong to is bound too (batch.test.ts).
      for (const a of artifacts) {
        expect(a.items).toHaveLength(1);
        expect(a.approver.type).toBe("person");
      }
      expect(new Set(artifacts.map((a) => a.items_hash)).size).toBe(3);
      expect(artifacts.map((a) => a.execution_id).sort()).toEqual(run.executions.map((e) => e.id).sort());
    }
  });

  it("partial-batch-failure: the refused line is one execution, and the line after it still settled", async () => {
    const scenario = loadScenario(agent, "partial-batch-failure");
    const run = await runScenario(agent, scenario, { mode: "human", runsDir });
    expect(run.executions.map((e) => e.state)).toEqual(["settled", "failed", "settled"]);
    expect(run.settled_total).toBe(174000);
    // Each line carries its own terminal state, so the refusal is `failed` on
    // one row while the others are `settled` on theirs.
    expect(run.executions[2]?.trail).toContain("executing");
    expect(run.receipts).toBe(2);
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
