/**
 * A charge that was out and unpaid when the run ended is the payer's doing,
 * not the model's: the rerun's payer pays, so it would settle an order the
 * original left open. The rerun says so instead of reporting that it DIFFERS.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function rerun(runsDir: string, runId: string) {
  const result = spawnSync(process.execPath, [BIN, "rerun", runId, "--json"], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CHECKOUT_RUNS_DIR: runsDir, CHECKOUT_STATE_DIR: join(runsDir, "state") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stderr: result.stderr, report: JSON.parse(result.stdout.trim()) as { same_states?: boolean; error?: string; not_replayed?: string[] } };
}

describe("npm run rerun <run-id> on a checkout run", () => {
  it("payment-claimed: the charge nobody paid is named, and nothing is replayed", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "checkout-rerun-unpaid-"));
    const original = await runScenario(agent, loadScenario(agent, "payment-claimed"), { mode: "human", rail: "stub", runsDir });
    expect(original.executions.map((e) => e.state)).toEqual(["executing"]);

    const out = rerun(runsDir, original.run_id);
    expect(out.code).toBe(1);
    expect(out.report.not_replayed).toEqual(["a payer who had not paid when it ended"]);
    expect(out.report.error).toBe(`runs/${original.run_id} cannot be compared with a rerun: it met a payer who had not paid when it ended, which a rerun does not replay`);
    expect(out.stderr).not.toContain("DIFFERS");
  });

  it("happy-path, where the payer paid, is replayed to the same states on the run's clock", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "checkout-rerun-paid-"));
    const original = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "human", rail: "stub", runsDir });
    const out = rerun(runsDir, original.run_id);
    expect(out.code).toBe(0);
    expect(out.report.same_states).toBe(true);
  });
});
