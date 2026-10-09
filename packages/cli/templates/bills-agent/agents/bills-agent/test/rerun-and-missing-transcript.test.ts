/**
 * Two refusals and one replay that need a real process: `rerun` on a run that
 * stopped at `awaiting_approval`, and `start --transcript` on a file that is
 * not there.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAdversarialCase, runAdversarialCase } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(NODE, [BIN, command, ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface RerunReport {
  same_states: boolean;
  original: string[];
  rerun: string[];
}

/**
 * A rerun recomputes every decision of the core and takes the person's from
 * the recording. Where the recording holds none, because nobody decided, the
 * rerun decides nothing either.
 */
describe("npm run rerun <run-id> on a run that stopped at awaiting_approval", () => {
  const LEFT = "1 execution(s) left in awaiting_approval, as the original left it";

  it("replays an adversarial case that only escalates to the same open approval", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "bills-rerun-open-"));
    const env = { BILLS_STATE_DIR: join(runsDir, "state"), BILLS_RUNS_DIR: runsDir };
    const original = await runAdversarialCase(agent, loadAdversarialCase(agent, "false-authority"), { runsDir });
    expect(original.ok).toBe(true);
    expect(original.states).toEqual(["awaiting_approval"]);

    const out = run("rerun", [original.run_id, "--json"], env);
    expect(out.stderr).not.toContain("DIFFERS");
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as RerunReport;
    expect(report.same_states).toBe(true);
    expect(report.original).toEqual(["awaiting_approval"]);
    expect(report.rerun).toEqual(["awaiting_approval"]);
    expect(out.stderr).toContain(`rerun ok: 1 transition(s), same sequence as ${original.run_id}; ${LEFT}`);
  });

  it("replays a one-shot nobody decided to the same open approval", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-rerun-open-"));
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
    const left = run("start", ["--input", "pague a escola de outubro", "--json"], env);
    expect(left.code).toBe(0);
    const { run_id } = JSON.parse(left.stdout.trim()) as { run_id: string };

    const out = run("rerun", [run_id, "--json"], env);
    expect(out.code).toBe(0);
    expect((JSON.parse(out.stdout.trim()) as RerunReport).rerun).toEqual(["awaiting_approval"]);
    expect(out.stderr).toContain(LEFT);
  });

  it("still replays the decision of a run somebody decided, and says nothing was left open", () => {
    for (const [flag, last] of [
      ["--approve", "settled"],
      ["--deny", "denied"],
    ] as const) {
      const stateDir = mkdtempSync(join(tmpdir(), "bills-rerun-decided-"));
      const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
      const decided = run("start", ["--input", "pague a escola de outubro", flag, "--json"], env);
      const { run_id } = JSON.parse(decided.stdout.trim()) as { run_id: string };

      const out = run("rerun", [run_id, "--json"], env);
      expect(out.code).toBe(0);
      const report = JSON.parse(out.stdout.trim()) as RerunReport;
      expect(report.same_states).toBe(true);
      expect(report.rerun.at(-1)).toBe(last);
      expect(out.stderr).toContain("rerun ok");
      expect(out.stderr).not.toContain("left in awaiting_approval, as the original");
    }
  });
});

describe("npm start -- --transcript <a file that is not there>", () => {
  it("refuses it by its path, with no stack, and opens no run", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-no-transcript-"));
    const runsDir = join(stateDir, "runs");
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir };
    const missing = join(stateDir, "nowhere.transcript.jsonl");

    // A path that does not exist, and one that exists and is a directory.
    for (const path of [missing, stateDir]) {
      const out = run("start", ["--input", "pague a escola de outubro", "--provider", "replay", "--transcript", path, "--json"], env);
      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr.trim()).toBe(`no transcript at ${path}`);
      expect(out.stderr).not.toMatch(/ENOENT|EISDIR/);
      expect(out.stderr).not.toMatch(/^\s+at /m);
    }
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
  });

  it("still replays a transcript that is there", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-transcript-"));
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
    const recorded = join(AGENT_DIR, "evals", "adversarial", "false-authority.transcript.jsonl");
    const out = run("start", ["--input", loadAdversarialCase(agent, "false-authority").input, "--mode", "mandate", "--provider", "replay", "--transcript", recorded, "--json"], env);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain(`replaying ${recorded}`);
  });
});
