/**
 * `npm run eval` writes a proof bundle per case and per scenario run, dozens a
 * pass. They go to `runs/eval/`, so `runs/` holds what the person ran, and
 * `inspect` and `rerun` still find an eval run by its id.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

describe("npm run eval beside a person's own runs", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "bills-eval-runs-"));
  const runsDir = join(stateDir, "runs");
  const run = (command: string, args: string[]) => {
    const result = spawnSync(process.execPath, [BIN, command, ...args], {
      cwd: AGENT_DIR,
      env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir },
      encoding: "utf8",
      timeout: 120_000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  let mine = "";
  let evalRuns: string[] = [];

  beforeAll(() => {
    const own = run("start", ["--input", "pague a escola de outubro", "--approve", "--json"]);
    mine = (JSON.parse(own.stdout.trim()) as { run_id: string }).run_id;
    expect(run("eval", []).code).toBe(0);
    evalRuns = readdirSync(join(runsDir, "eval")).sort();
  }, 120_000);

  it("leaves runs/ with the person's run and one folder for the suite's", () => {
    expect(readdirSync(runsDir).sort()).toEqual(["eval", mine].sort());
    // 8 adversarial cases and 11 scenario runs.
    expect(evalRuns).toHaveLength(19);
    expect(evalRuns.some((id) => id.startsWith("run_adv_"))).toBe(true);
  });

  it("inspect finds an eval run by its id alone, and by eval/<id>", () => {
    const id = evalRuns.find((r) => r.startsWith("run_adv_prompt-injection"))!;
    for (const arg of [id, `eval/${id}`]) {
      const out = run("inspect", [arg, "--json"]);
      expect(out.code).toBe(0);
      expect((JSON.parse(out.stdout.trim()) as { run: { run_id: string } }).run.run_id).toBe(id);
    }
    expect(run("inspect", [mine, "--json"]).code).toBe(0);
  });

  it("an unknown id lists the person's runs and counts the suite's, without listing them", () => {
    const out = run("inspect", ["run_nope"]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`  ${mine}`);
    expect(out.stderr).toContain(`19 more from \`npm run eval\` in ${join(runsDir, "eval")}`);
    expect(out.stderr).not.toContain("run_adv_");
    expect(out.stderr).not.toMatch(/^ {2}eval$/m);
  });

  it("the folder itself is not a run, and a path out of runs/ is not one either", () => {
    for (const arg of ["eval", "eval/", "eval/../..", "../runs"]) {
      const out = run("inspect", [arg]);
      expect([arg, out.code]).toEqual([arg, 1]);
      expect(out.stderr).toContain(`no proof bundle for run ${arg}`);
      expect(out.stderr).not.toMatch(/^\s+at /m);
    }
  });

  it("rerun replays an eval run by its id and leaves the rerun beside it, not among the person's", () => {
    const id = evalRuns.find((r) => r.startsWith("run_adv_prompt-injection"))!;
    const out = run("rerun", [id, "--json"]);
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as { same_states: boolean; rerun_id: string };
    expect(report.same_states).toBe(true);
    expect(readdirSync(join(runsDir, "eval"))).toContain(report.rerun_id);
    expect(readdirSync(runsDir).sort()).toEqual(["eval", mine].sort());
  });
});
