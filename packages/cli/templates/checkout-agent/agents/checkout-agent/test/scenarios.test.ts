import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofBundle } from "@codespar/agent-core";
import { assembleTimeline, checkScenario, listScenarios, loadScenario, renderText, runScenario, type ScenarioRun } from "@codespar/agent-runtime";
import { CUSTOMERS } from "../src/catalog.js";
import { agent } from "../src/kit.js";

const runsDir = mkdtempSync(join(tmpdir(), "checkout-runs-"));
const DOCUMENTS = CUSTOMERS.map((c) => c.document);
type Artifact = { execution_id: string; approver: { type: string }; items_hash: string; items: Array<{ amount: number; due_date?: string }>; composition?: { ref: string; composition_hash: string; line_count: number } };
const approvals = (run: ScenarioRun): Artifact[] => {
  const path = join(run.bundle_dir, "approval.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Artifact[]) : [];
};
const events = (run: ScenarioRun) => readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; actor?: unknown; payload?: Record<string, unknown> });

describe("checkout §6: scenario packs, on the replay provider and the stub rail", () => {
  const required = ["happy-path", "cart-replaced", "cart-recomposed", "price-injected", "coupon-unknown", "payment-claimed", "item-unavailable", "escalated-above-threshold", "charge-expired", "cap-exceeded", "beneficiary-not-allowed", "mandate-revoked", "prompt-injection", "nfse-failed"];

  it("ships the fourteen scenarios of checkout §6", () => {
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
        const all = events(run);
        expect(all.length).toBeGreaterThan(0);
        for (const e of all) expect(e.actor).toBeDefined();
        for (const file of readdirSync(join(run.bundle_dir, "receipts"))) {
          const receipt = JSON.parse(readFileSync(join(run.bundle_dir, "receipts", file), "utf8")) as { actor?: unknown; kind?: string; chain: string | null; payment: { payee: string | null; money_moved: boolean } };
          expect(receipt.actor).toBeDefined();
          expect(receipt.kind).toBe("charge");
          expect(receipt.chain).toBeNull();
          expect(receipt.payment.money_moved).toBe(false);
        }
        const snapshot = readFileSync(join(run.bundle_dir, "mandate.snapshot.json"), "utf8");
        for (const doc of DOCUMENTS) expect(snapshot).not.toContain(doc);
        // Every order that reached executing did so under an artifact that carries its composition, and that composition is the one it ran with.
        for (const e of run.executions) {
          if (!e.trail.includes("executing")) continue;
          const artifact = approvals(run).filter((a) => a.execution_id === e.id).at(-1);
          expect(artifact?.composition?.ref).toMatch(/\/cart-\d+$/);
        }
      });
    }
  }

  it("happy-path: the same records in human and in mandate; the person decided in human, the policy in mandate; the order is due today", async () => {
    const scenario = loadScenario(agent, "happy-path");
    const human = await runScenario(agent, scenario, { mode: "human", runsDir });
    const mandate = await runScenario(agent, scenario, { mode: "mandate", runsDir });
    const [h] = approvals(human);
    const [m] = approvals(mandate);
    expect(h!.approver.type).toBe("person");
    expect(m!.approver.type).toBe("mandate");
    expect(h!.items_hash).toBe(m!.items_hash);
    expect(h!.composition!.composition_hash).toBe(m!.composition!.composition_hash);
    expect(h!.composition!.line_count).toBe(2);
    expect(h!.items).toEqual([expect.objectContaining({ amount: 47990, due_date: "2026-09-23" })]);
    for (const run of [human, mandate]) {
      const all = events(run);
      expect(all.filter((e) => e.type === "charge.instrument" && e.payload?.["payable"] === true)).toHaveLength(1);
      expect(all.filter((e) => e.type === "message.debtor")).toHaveLength(1);
      expect(all.filter((e) => e.type === "commerce.charge.paid")).toHaveLength(1);
      expect(all.filter((e) => e.type === "rail.dispatch")).toHaveLength(1);
    }
  });

  it("cart-recomposed: the two artifacts share items_hash and differ only in the composition, and one charge goes out", async () => {
    for (const mode of ["human", "mandate"] as const) {
      const run = await runScenario(agent, loadScenario(agent, "cart-recomposed"), { mode, runsDir });
      const [first, second] = approvals(run);
      expect(approvals(run)).toHaveLength(2);
      expect(first!.items_hash).toBe(second!.items_hash);
      expect(first!.composition!.composition_hash).not.toBe(second!.composition!.composition_hash);
      expect(first!.composition!.ref).toBe(second!.composition!.ref);
      expect(run.charges_issued).toBe(1);
      const restated = events(run).filter((e) => e.type === "execution.restated");
      expect(restated).toHaveLength(1);
      expect(restated[0]!.payload!["items_hash"]).toMatchObject({ from: first!.items_hash, to: first!.items_hash });
    }
  });

  it("npm run inspect reads the composition back from the artifact, beside items_hash", async () => {
    const run = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "human", runsDir });
    const text = renderText(assembleTimeline(new ProofBundle(runsDir, run.run_id)));
    expect(text).toContain(`composed of 2 line(s) of ${run.run_id}/cart-1 · composition_hash ${approvals(run)[0]!.composition!.composition_hash}`);
  });

  it("cart-replaced: the order follows the cart, and the charge is for five lessons, never for two", async () => {
    const run = await runScenario(agent, loadScenario(agent, "cart-replaced"), { mode: "human", runsDir });
    const dispatched = events(run).filter((e) => e.type === "rail.dispatch").map((e) => e.payload?.["amount"]);
    expect(dispatched).toEqual([50000]);
    expect(approvals(run).map((a) => a.items[0]!.amount)).toEqual([20000, 50000]);
  });

  it("coupon-unknown and item-unavailable: the issue is named by code in the cart the model read", async () => {
    for (const [name, code] of [["coupon-unknown", "coupon_unknown"], ["item-unavailable", "item_unavailable"]] as const) {
      const run = await runScenario(agent, loadScenario(agent, name), { mode: "human", runsDir });
      const replaced = events(run).filter((e) => e.type === "cart.replaced");
      expect((replaced[0]!.payload!["validation_issues"] as Array<{ code: string }>).map((i) => i.code)).toEqual([code]);
      expect(run.executions).toEqual([]);
    }
  });
});
