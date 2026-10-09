/**
 * Two things `npm start` says with no model key: which recording an `--input`
 * replays, and how long a scenario pack took.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

function start(args: string[]) {
  const stateDir = mkdtempSync(join(tmpdir(), "checkout-reach-"));
  const result = spawnSync(process.execPath, [BIN, "start", ...args], {
    cwd: AGENT_DIR,
    // Pinned inside the service hours, as the other process tests of this agent are.
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-09-23T14:00:00-03:00", CHECKOUT_STATE_DIR: stateDir, CHECKOUT_RUNS_DIR: join(stateDir, "runs") },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("npm start -- --input <the first turn of a scenario>", () => {
  // The three that opened with one sentence, of which --input could only ever replay the first.
  it.each(["cart-recomposed", "cart-replaced", "charge-expired"])("%s: replays its own recording", (name) => {
    const out = start(["--input", loadScenario(agent, name).turns[0]!.input, "--json"]);
    expect(out.code).toBe(0);
    expect(out.stderr).toContain(`replaying ${join(AGENT_DIR, "scenarios", `${name}.transcript.jsonl`)}`);
  });
});

describe("npm start -- --scenario <name> on the stub rail", () => {
  it("says ok and where the bundle is, and no seconds: the stub's clock is the scenario's, not a watch", () => {
    const began = Date.now();
    const out = start(["--scenario", "happy-path", "--mode", "human"]);
    const wall = (Date.now() - began) / 1000;
    expect(out.code).toBe(0);
    const ok = out.stderr.split("\n").find((line) => line.startsWith("== ok"))!;
    expect(ok).toMatch(/^== ok — bundle em /);
    expect(ok).not.toMatch(/\d+(\.\d+)?s — /);
    // What the line used to claim: the scenario's clock counts 16 seconds here, and the process takes a fraction of that.
    expect(wall).toBeLessThan(16);
  });

  it("--json still carries the cycle the scenario's clock counted, for the checks that read it", () => {
    const out = start(["--scenario", "happy-path", "--mode", "human", "--json"]);
    const report = JSON.parse(out.stdout.trim()) as { results: Array<{ ok: boolean; run: { rail: string; cycle_seconds: number | null } }> };
    expect(report.results[0]).toMatchObject({ ok: true, run: { rail: "stub", cycle_seconds: expect.any(Number) } });
  });
});
