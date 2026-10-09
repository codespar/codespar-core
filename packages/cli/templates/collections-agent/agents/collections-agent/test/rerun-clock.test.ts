/**
 * A rerun replays the run on the run's own clock. The scenario issues an
 * instalment due 2026-09-30 on a run that started 2026-09-23; replayed on
 * today's date the due date has passed, the envelope refuses the agreement,
 * and the rerun reported a run that DIFFERS from one it had every byte of.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProofBundle } from "@codespar/agent-core";
import { loadScenario, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function rerun(runsDir: string, runId: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [BIN, "rerun", runId, "--json"], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "", COLLECTIONS_RUNS_DIR: runsDir, COLLECTIONS_STATE_DIR: join(runsDir, "state"), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stderr: result.stderr, report: JSON.parse(result.stdout.trim()) as { same_states: boolean; original: string[]; rerun: string[]; rerun_id: string } };
}

describe("npm run rerun <run-id> on a run from another day", () => {
  it.each(["human", "mandate"] as const)("replays happy-path [%s] to the same states, on the clock the run started on", async (mode) => {
    const runsDir = mkdtempSync(join(tmpdir(), "collections-rerun-clock-"));
    const original = await runScenario(agent, loadScenario(agent, "happy-path"), { mode, rail: "stub", runsDir });
    expect(original.executions.map((e) => e.state)).toEqual(["settled"]);
    // The run is on the scenario's date, which is not today's: what a rerun used to ignore.
    const startedAt = String(ProofBundle.open(runsDir, original.run_id)!.readMeta()!["started_at"]);
    expect(startedAt.slice(0, 10)).toBe("2026-09-23");
    expect(Math.abs(Date.now() - Date.parse(startedAt))).toBeGreaterThan(24 * 3600 * 1000);

    const out = rerun(runsDir, original.run_id);
    expect(out.stderr).not.toContain("já passou");
    expect(out.report.rerun).toEqual(out.report.original);
    expect(out.report.same_states).toBe(true);
    expect(out.code).toBe(0);
    // The rerun's own bundle says when it ran: where the original did.
    expect(ProofBundle.open(runsDir, out.report.rerun_id)!.readMeta()!["started_at"]).toBe(startedAt);
  });

  it("the run's clock wins over one the shell pins", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "collections-rerun-clock-"));
    const original = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "mandate", rail: "stub", runsDir });
    const out = rerun(runsDir, original.run_id, { CODESPAR_AGENT_NOW: "2027-01-15T12:00:00.000Z" });
    expect(out.report.same_states).toBe(true);
  });
});
