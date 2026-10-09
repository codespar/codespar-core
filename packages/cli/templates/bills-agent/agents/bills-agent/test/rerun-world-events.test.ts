/**
 * A rerun replays the model's side and the person's decisions. What the world
 * did in the original (the mandate revoked mid-run, a rail that answered
 * "uncertain") is not replayed, and a rerun that ignored it paid what the
 * original denied and reported a run that DIFFERS. It refuses by name.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function rerun(runsDir: string, args: string[]) {
  const result = spawnSync(process.execPath, [BIN, "rerun", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_RUNS_DIR: runsDir, BILLS_STATE_DIR: join(runsDir, "state") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm run rerun <run-id> on a run the world interfered with", () => {
  it.each(["human", "mandate"] as const)("mandate-revoked [%s]: names the revocation and the uncertain answer, and replays nothing", async (mode) => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-rerun-world-"));
    const original = await runScenario(agent, loadScenario(agent, "mandate-revoked"), { mode, rail: "stub", runsDir });
    expect(original.executions.map((e) => e.state)).toEqual(["settled", "settled", "denied"]);
    const NAMED = `runs/${original.run_id} cannot be compared with a rerun: it met an uncertain answer from the rail, and a mandate that was revoked, which a rerun does not replay`;

    const out = rerun(runsDir, [original.run_id]);
    expect(out.code).toBe(1);
    expect(out.stderr.trim().split("\n").at(-1)).toBe(NAMED);
    expect(out.stderr).not.toContain("DIFFERS");
    expect(out.stdout).toBe("");

    const asJson = rerun(runsDir, [original.run_id, "--json"]);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout.trim())).toEqual({ run_id: original.run_id, error: NAMED, not_replayed: ["an uncertain answer from the rail", "a mandate that was revoked"] });
    // Nothing was replayed: the runs folder holds the original and no rerun of it.
    expect(readdirSync(runsDir).filter((entry) => entry.startsWith("run_"))).toEqual([original.run_id]);
  });

  it("a run the world left alone is still replayed", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-rerun-world-"));
    const original = await runScenario(agent, loadScenario(agent, "happy-path"), { mode: "human", rail: "stub", runsDir });
    const out = rerun(runsDir, [original.run_id]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("rerun ok");
  });
});
