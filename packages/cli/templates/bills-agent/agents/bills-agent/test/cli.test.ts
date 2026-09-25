/**
 * The contracts that need a real process: `--json` on stdout and nothing
 * else, the restart in `executing` followed by `resume`, and `rerun`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

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

describe("npm start -- --input ... --json", () => {
  it("prints valid JSON on stdout and nothing else; people go to stderr", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-json-"));
    const out = run("start", ["--input", "pague a escola de outubro", "--approve", "--json"], { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") });
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { run_id: string; mode: string; actor: { type: string }; executions: Array<{ state: string; receipt_ids: string[] }>; receipts: string[] };
    expect(payload.mode).toBe("human");
    expect(payload.actor.type).toBe("agent");
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(payload.receipts).toHaveLength(1);
    expect(out.stderr).toContain("replay");
  });

  it("replays when ANTHROPIC_API_KEY still holds the .env.example placeholder", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-placeholder-"));
    const out = run("start", ["--input", "pague a escola de outubro", "--approve", "--json"], { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs"), ANTHROPIC_API_KEY: "sk-ant-your_key_here" });
    expect(out.code).toBe(0);
    expect(out.stderr).toContain("[replay] no ANTHROPIC_API_KEY");
    const payload = JSON.parse(out.stdout.trim()) as { executions: Array<{ state: string }> };
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
  });

  it("refuses a key outside csk_test_ before anything else", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-live-"));
    const out = run("start", ["--input", "pague a escola de outubro", "--json"], { BILLS_STATE_DIR: stateDir, CODESPAR_API_KEY: ["csk", "live", "0000000000"].join("_") });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("csk_test_");
  });
});

// #16: `escalate_above.outside_hours` (22:00-07:00) reads the engine clock too. The escalation order is amount, new_beneficiary,
// outside_hours, so the hour can only be the trigger on a payee the mandate already knows, below the amount threshold: the
// state is seeded with one settled payment to the school first, in its own process, the way a real day would.
describe("--now pins the clock the mandate-mode escalation reads", () => {
  function seedKnownPayee(label: string): Record<string, string> {
    const stateDir = mkdtempSync(join(tmpdir(), `bills-now-${label}-`));
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
    const seed = run("start", ["--mode", "mandate", "--input", "paga 400 reais pra escola (material)", "--transcript", "test/fixtures/material-400.transcript.jsonl", "--approve", "--json", "--now", "2026-09-23T14:00:00-03:00"], env);
    expect(seed.code).toBe(0);
    const payload = JSON.parse(seed.stdout.trim()) as { executions: Array<{ state: string; escalation: { trigger: string } | null }> };
    expect(payload.executions[0]).toMatchObject({ state: "settled", escalation: { trigger: "new_beneficiary" } });
    return env;
  }
  const EXCURSAO = ["--mode", "mandate", "--input", "e mais 300 reais pra escola, a excursao", "--transcript", "test/fixtures/excursao-300.transcript.jsonl", "--json"];
  type Payload = { executions: Array<{ state: string; escalation: { trigger: string; detail: string } | null; receipt_ids: string[] }> };

  it("at 23:00 America/Sao_Paulo a payment inside the mandate is escalated (outside_hours) and waits for a human", () => {
    const out = run("start", [...EXCURSAO, "--now", "2026-09-23T23:00:00-03:00"], seedKnownPayee("night"));
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.stdout.trim()) as Payload;
    expect(payload.executions).toHaveLength(1);
    expect(payload.executions[0]).toMatchObject({ state: "awaiting_approval", escalation: { trigger: "outside_hours" } });
    expect(payload.executions[0]?.escalation?.detail).toContain("23:00");
    expect(payload.executions[0]?.receipt_ids).toEqual([]);
  });

  it("at 14:00 America/Sao_Paulo the same payment runs alone: no trigger, one receipt", () => {
    const out = run("start", [...EXCURSAO, "--now", "2026-09-23T14:00:00-03:00"], seedKnownPayee("day"));
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.stdout.trim()) as Payload;
    expect(payload.executions[0]).toMatchObject({ state: "settled", escalation: null });
    expect(payload.executions[0]?.receipt_ids).toHaveLength(1);
  });
});

describe("section 10: restart in executing, then resume", () => {
  it("one payment, one receipt, never two", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-restart-"));
    const runsDir = join(stateDir, "runs");
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir };

    const killed = run("start", ["--input", "pague a escola de outubro", "--approve", "--json"], { ...env, BILLS_KILL_AFTER_DISPATCH: "1" });
    expect(killed.code).toBe(137);
    expect(killed.stdout).toBe("");

    const db = new DatabaseSync(join(stateDir, "state.db"));
    const stuck = db.prepare("SELECT state FROM executions").all() as Array<{ state: string }>;
    expect(stuck).toEqual([{ state: "executing" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(1);
    db.close();

    const resumed = run("resume", ["--json"], env);
    expect(resumed.code).toBe(0);
    const payload = JSON.parse(resumed.stdout.trim()) as { resumed: Array<{ state: string; receipt_ids: string[] }> };
    expect(payload.resumed).toHaveLength(1);
    expect(payload.resumed[0]?.state).toBe("settled");
    expect(payload.resumed[0]?.receipt_ids).toHaveLength(1);

    const db2 = new DatabaseSync(join(stateDir, "state.db"));
    expect((db2.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(1);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'commerce.payment.succeeded'").get() as { n: number }).n).toBe(1);
    expect(db2.prepare("SELECT state FROM executions").all()).toEqual([{ state: "settled" }]);
    db2.close();

    const receipts = readdirSync(runsDir).flatMap((r) => (existsSync(join(runsDir, r, "receipts")) ? readdirSync(join(runsDir, r, "receipts")) : []));
    expect(receipts).toHaveLength(1);

    const again = run("resume", ["--json"], env);
    expect(JSON.parse(again.stdout.trim())).toMatchObject({ resumed: [] });
  });
});

describe("npm run rerun <run-id>", () => {
  it("reproduces a recorded run without network, with the same state sequence", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-rerun-"));
    const runsDir = join(stateDir, "runs");
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir };
    const first = run("start", ["--input", "pague a escola de outubro", "--approve", "--json"], env);
    expect(first.code).toBe(0);
    const { run_id } = JSON.parse(first.stdout.trim()) as { run_id: string };
    const rerun = run("rerun", [run_id, "--json"], env);
    expect(rerun.code).toBe(0);
    const payload = JSON.parse(rerun.stdout.trim()) as { same_states: boolean; original: string[]; rerun: string[] };
    expect(payload.same_states).toBe(true);
    expect(payload.original).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(readFileSync(join(runsDir, run_id, "transcript.jsonl"), "utf8")).toContain("assistant_step");
  });
});

describe("npm run check", () => {
  it("is green for the shipped agent and prints JSON with --json", () => {
    const out = run("check", ["--json"], {});
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as { ok: boolean; agent: string; findings: unknown[] };
    expect(report).toMatchObject({ ok: true, agent: "bills-agent" });
    expect(report.findings.filter((f) => (f as { level: string }).level === "error")).toEqual([]);
  });
});

describe("npm run approve / deny <execution-id>", () => {
  it("decides an execution left awaiting, produces the artifact and runs it through the last gate", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-decide-"));
    const runsDir = join(stateDir, "runs");
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir };
    const left = run("start", ["--input", "pague a escola de outubro", "--json"], env);
    expect(left.code).toBe(0);
    const payload = JSON.parse(left.stdout.trim()) as { executions: Array<{ id: string; state: string }> };
    expect(payload.executions[0]?.state).toBe("awaiting_approval");
    const id = payload.executions[0]!.id;

    const denied = run("deny", ["nope_unknown", "--json"], env);
    expect(denied.code).toBe(1);

    const approved = run("approve", [id, "--user", "usr_titular", "--json"], env);
    expect(approved.code).toBe(0);
    const out = JSON.parse(approved.stdout.trim()) as { state: string; approval_id: string | null; receipt_ids: string[]; bundle_dir: string };
    expect(out.state).toBe("settled");
    expect(out.approval_id).toMatch(/^apr_/);
    expect(out.receipt_ids).toHaveLength(1);
    const artifacts = JSON.parse(readFileSync(join(AGENT_DIR, out.bundle_dir, "approval.json"), "utf8")) as Array<{ approver: { type: string; id: string } }>;
    expect(artifacts[0]?.approver).toEqual({ type: "person", id: "usr_titular", channel: "terminal" });

    const again = run("approve", [id, "--json"], env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("not awaiting_approval");
  });

  it("deny leaves a terminal denied execution and sends nothing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-deny-"));
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
    const left = run("start", ["--input", "pague a escola de outubro", "--json"], env);
    const id = (JSON.parse(left.stdout.trim()) as { executions: Array<{ id: string }> }).executions[0]!.id;
    const denied = run("deny", [id, "--json"], env);
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.stdout.trim())).toMatchObject({ state: "denied", reason: "denied_by_approver", receipt_ids: [] });
    const db = new DatabaseSync(join(stateDir, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("partial failure of a multi-item execution, and rerun reproducing it", () => {
  it("pays every bill the rail accepted, names the one it refused, and rerun replays the refusal", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bills-partial-"));
    const runsDir = join(stateDir, "runs");
    const env = { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir, BILLS_STUB_REFUSE: "+5511999990001" };
    const first = run("start", ["--input", "libera o lote do mes", "--transcript", "evals/adversarial/false-authority.transcript.jsonl", "--approve", "--json"], env);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout.trim()) as { run_id: string; executions: Array<{ state: string; receipt_ids: string[] }>; receipts: string[] };
    // Four bills, the SECOND refused by the rail. The execution closes `failed`
    // because one attempt failed, and the two bills after the refused one are
    // paid all the same: an attempt's outcome is that attempt's business.
    expect(payload.executions[0]?.state).toBe("failed");
    expect(payload.executions[0]?.receipt_ids).toHaveLength(3);
    expect(payload.receipts).toHaveLength(3);
    const events = readFileSync(join(runsDir, payload.run_id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: { status?: string } });
    expect(events.filter((e) => e.type === "rail.outcome").map((e) => e.payload.status)).toEqual(["settled", "failed", "settled", "settled"]);

    const rerun = run("rerun", [payload.run_id, "--json"], { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: runsDir });
    expect(rerun.code).toBe(0);
    const r = JSON.parse(rerun.stdout.trim()) as { same_states: boolean; original: string[]; rerun: string[]; original_outcomes: string[]; rerun_outcomes: string[] };
    expect(r.same_states).toBe(true);
    expect(r.original).toEqual(["awaiting_approval", "approved", "executing", "failed"]);
    expect(r.original_outcomes).toEqual(["settled", "failed", "settled", "settled"]);
    expect(r.rerun_outcomes).toEqual(["settled", "failed", "settled", "settled"]);
  });
});
