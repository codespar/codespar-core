/**
 * `inspect` through a real process: the section 14.5 rule (`--json` puts valid
 * JSON on stdout and nothing else), the refusal on a run id that is not there,
 * and the HTML file that opens from disk with nothing fetched.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

describe("codespar-agent inspect", () => {
  let env: Record<string, string>;
  let runId: string;
  let runs: string;

  beforeAll(() => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-inspect-"));
    runs = join(stateDir, "runs");
    env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runs };
    const paid = run("start", ["--input", "pague a escola de outubro", "--approve", "--json", "--now", "2026-09-23T14:00:00-03:00"], env);
    expect(paid.code).toBe(0);
    runId = (JSON.parse(paid.stdout.trim()) as { run_id: string }).run_id;
  });

  it("--json puts valid JSON on stdout and nothing else", () => {
    const out = run("inspect", [runId, "--json"], env);
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as {
      run: { run_id: string; mode: string; rail: string; mandate_id: string; mandate_version: number };
      executions: Array<{ final_state: string; approval: { items_hash: string } | null; transitions: Array<{ to: string; actor: string }>; attempts: Array<{ idempotency_key: string; answer: { status: string; receipt_id: string } }> }>;
      receipts: Array<{ receipt_id: string }>;
      verify: { present: boolean; note: string };
    };
    expect(report.run).toMatchObject({ run_id: runId, mode: "human", rail: "stub" });
    expect(report.run.mandate_version).toBe(1);
    const execution = report.executions[0]!;
    expect(execution.final_state).toBe("settled");
    expect(execution.transitions.map((t) => t.to)).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(execution.approval?.items_hash).toMatch(/^sha256:/);
    expect(execution.attempts[0]?.idempotency_key).toMatch(/^idk_/);
    expect(execution.attempts[0]?.answer.status).toBe("settled");
    expect(report.receipts).toHaveLength(1);
    expect(report.verify.present).toBe(false);
  });

  it("the default rendering is for a person and names the approver, the hash and the receipt", () => {
    const out = run("inspect", [runId], env);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(runId);
    expect(out.stdout).toContain("bills-agent@0.1.0");
    expect(out.stdout).toContain("items_hash sha256:");
    expect(out.stdout).toContain("rail says");
    expect(out.stdout).toContain("receipts/rcpt_");
    // Masked exactly as the bundle masks it.
    expect(out.stdout).toContain("fi***@escola-aurora.example.com.br");
    expect(out.stdout).not.toContain("financeiro@escola-aurora.example.com.br");
  });

  it("refuses a run id that is not there, cleanly, and says which ones are", () => {
    const out = run("inspect", ["run_does_not_exist"], env);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("no proof bundle for run run_does_not_exist");
    expect(out.stderr).toContain(runId);
    expect(out.stderr).not.toMatch(/at Object\.|at async |Error:/);
  });

  it("refuses with a usage line when no run id is given", () => {
    const out = run("inspect", [], env);
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("usage: npm run inspect <run-id>");
  });

  it("--html writes one standalone file: no script, no external src or href", () => {
    const target = join(mkdtempSync(join(tmpdir(), "bills-inspect-html-")), "run.html");
    const out = run("inspect", [runId, "--html", target], env);
    expect(out.code).toBe(0);
    const html = readFileSync(target, "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).toContain(runId);
    expect(html).toContain("items_hash sha256:");
    expect(html).not.toContain("financeiro@escola-aurora.example.com.br");
  });

  it("a bundle a killed run left half-written is a message, not a stack trace", () => {
    const broken = join(runs, "run_broken_bundle");
    mkdirSync(join(broken, "receipts"), { recursive: true });
    writeFileSync(join(broken, "approval.json"), "{ this is not json");
    const out = run("inspect", ["run_broken_bundle"], env);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("could not be read");
    expect(out.stderr).not.toMatch(/at Object\.|at async |\.ts:\d+/);
    rmSync(broken, { recursive: true, force: true });
  });

  it("works on any bundle in the runs folder, whatever produced it", () => {
    const ids = readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(ids).toContain(runId);
    for (const id of ids) expect(run("inspect", [id, "--json"], env).code).toBe(0);
  });
});
