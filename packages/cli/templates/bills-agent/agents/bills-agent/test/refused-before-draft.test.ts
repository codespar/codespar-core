/**
 * A request made under a revoked mandate creates no execution: the engine
 * refuses it before a draft. The terminal used to say nothing about it (the
 * recorded reply even says "see the result on the terminal"), and only
 * `inspect` showed the event. Driven as real processes, over a scratch state
 * whose stub mandate is revoked between two runs.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const SCHOOL = "pague a escola de outubro";
const BASE_ENV = { ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-10-07T14:00:00-03:00" };

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [BIN, "start", ...args], { cwd: AGENT_DIR, env: { ...process.env, ...BASE_ENV, ...env }, encoding: "utf8", timeout: 60_000 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A scratch state holding one settled payment, with the stub mandate then revoked: what `codespar mandate revoke` leaves behind. */
function revoked(label: string): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), `bills-refused-${label}-`));
  const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
  const first = run(["--input", SCHOOL, "--approve", "--json"], env);
  expect(first.code).toBe(0);
  const mandateId = (JSON.parse(first.stdout.trim()) as { mandate_id: string }).mandate_id;
  const db = new DatabaseSync(join(stateDir, "state.db"));
  db.prepare("INSERT OR REPLACE INTO stub_mandate_status (mandate_id, status, reason, updated_at) VALUES (?, 'revoked', 'revoked by the test', ?)").run(mandateId, new Date().toISOString());
  db.close();
  return env;
}

describe("a request under a revoked mandate, one-shot", () => {
  it("names the refusal and its reason on the terminal, counts it, and exits 1", () => {
    const out = run(["--input", SCHOOL, "--approve"], revoked("text"));
    expect(out.stderr).toContain("-> refused_before_draft (mandate_revoked)");
    expect(out.stdout).toContain("resultado deste run: 0 liquidada(s), 1 com falha ou recusada(s)");
    expect(out.code).toBe(1);
  });

  it("carries the same refusal in --json, with no execution", () => {
    const out = run(["--input", SCHOOL, "--approve", "--json"], revoked("json"));
    const payload = JSON.parse(out.stdout.trim()) as { executions: unknown[]; run_outcome: { failed: number }; refused_before_draft: Array<{ reason: string; detail: string }> };
    expect(payload.executions).toHaveLength(0);
    expect(payload.refused_before_draft).toHaveLength(1);
    expect(payload.refused_before_draft[0]).toMatchObject({ reason: "mandate_revoked" });
    expect(payload.refused_before_draft[0]?.detail).not.toBe("");
    expect(payload.run_outcome.failed).toBe(1);
    expect(out.code).toBe(1);
  });
});

describe("a request under a revoked mandate, interactive", () => {
  it("names the refusal under the turn that made it", async () => {
    const env = revoked("interactive");
    const out = await new Promise<{ stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [BIN, "start", "--transcript", "scenarios/mandate-revoked.transcript.jsonl"], { cwd: AGENT_DIR, env: { ...process.env, ...BASE_ENV, ...env } });
      let stdout = "";
      let stderr = "";
      let typed = false;
      // Typed when the prompt shows: readline drops a line that arrives before the question.
      const feed = () => {
        if (!typed && stderr.includes("> ")) {
          typed = true;
          child.stdin.end(SCHOOL + "\n");
        }
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); feed(); });
      child.on("error", fail);
      child.on("close", () => done({ stdout, stderr }));
    });
    expect(out.stderr).toContain("-> refused_before_draft (mandate_revoked)");
    expect(out.stdout).toContain("1 com falha ou recusada(s)");
  });
});
