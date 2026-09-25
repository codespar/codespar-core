/**
 * The contracts that need a real process: `--json` on stdout and nothing
 * else, the live-key refusal, the restart after the issuance followed by
 * `resume` and `poll`, `rerun`, `approve`/`deny`, and `check`.
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
const HAPPY = "oi, recebi a mensagem sobre o acordo do pedido 1042";

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(NODE, [BIN, command, ...args], {
    cwd: AGENT_DIR,
    // Pinned inside collection hours (#16): these processes must not depend on the hour the suite runs at. A test overrides it.
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-09-23T14:00:00-03:00", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scratch(label: string): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), `collections-${label}-`));
  return { COLLECTIONS_STATE_DIR: stateDir, COLLECTIONS_RUNS_DIR: join(stateDir, "runs") };
}

describe("npm start -- --input ... --json", () => {
  it("prints valid JSON on stdout and nothing else; the QR and the people go to stderr", () => {
    const env = scratch("json");
    // The recorded happy-path's first turn is a proposal, no execution: the second turn issues.
    const out = run("start", ["--input", HAPPY, "--json"], env);
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { run_id: string; mode: string; actor: { type: string }; executions: unknown[]; tool_calls: Array<{ name: string }> };
    expect(payload.mode).toBe("human");
    expect(payload.actor.type).toBe("agent");
    expect(payload.executions).toEqual([]);
    expect(payload.tool_calls.map((c) => c.name)).toEqual(["list_agreements"]);
    expect(out.stderr).toContain("replay");
  });

  it("an accepted proposal, approved with the payer simulated, settles in one process and the QR never reaches stdout", () => {
    const env = scratch("settle");
    const out = run("start", ["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--approve", "--simulate-payer", "--json"], env);
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as { executions: Array<{ state: string; charges: Array<{ charge_id: string; status: string }>; receipt_ids: string[] }>; receipts: string[] };
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(payload.executions[0]?.charges).toHaveLength(1);
    expect(payload.receipts).toHaveLength(1);
    expect(out.stderr).toContain("copia e cola");
  });

  // #16: the collection-hours guardrail reads the engine clock. Pinned, the gate is the same at 03:00 and at 15:00.
  describe("--now pins the clock the guardrails read", () => {
    const ARGS = ["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--approve", "--simulate-payer", "--json"];
    type Payload = { executions: Array<{ state: string; reason: string | null; charges: unknown[] }>; receipts: string[] };

    it("at 20:08 America/Sao_Paulo the fixture is denied (outside_hours) and nothing is issued", () => {
      const out = run("start", [...ARGS, "--now", "2026-09-23T20:08:00-03:00"], scratch("now-night"));
      expect(out.code).toBe(0);
      const payload = JSON.parse(out.stdout.trim()) as Payload;
      expect(payload.executions).toHaveLength(1);
      expect(payload.executions[0]).toMatchObject({ state: "denied", reason: "outside_hours", charges: [] });
      expect(payload.receipts).toHaveLength(0);
      expect(out.stderr).toContain("agora sao 20:08");
    });

    it("at 14:00 America/Sao_Paulo the same command settles, whatever the wall clock says", () => {
      const out = run("start", [...ARGS, "--now", "2026-09-23T14:00:00-03:00"], scratch("now-day"));
      expect(out.code).toBe(0);
      const payload = JSON.parse(out.stdout.trim()) as Payload;
      expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
      expect(payload.executions[0]?.charges).toHaveLength(1);
      expect(payload.receipts).toHaveLength(1);
    });

    it("CODESPAR_AGENT_NOW is the same pin from the environment; an unparseable value exits 2 before anything runs", () => {
      const out = run("start", ARGS, { ...scratch("now-env"), CODESPAR_AGENT_NOW: "2026-09-23T20:08:00-03:00" });
      expect(out.code).toBe(0);
      expect((JSON.parse(out.stdout.trim()) as Payload).executions[0]).toMatchObject({ state: "denied", reason: "outside_hours" });

      const bad = run("start", [...ARGS, "--now", "yesterday"], scratch("now-bad"));
      expect(bad.code).toBe(2);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toContain("--now must be an ISO 8601 instant");
    });
  });

  it("refuses a key outside csk_test_ before anything else", () => {
    const env = scratch("live");
    const out = run("start", ["--input", HAPPY, "--json"], { ...env, CODESPAR_API_KEY: ["csk", "live", "0000000000"].join("_") });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("csk_test_");
  });
});

describe("section 10: restart after the issuance, then resume and poll", () => {
  it("one receivable, one settlement, never two", () => {
    const env = scratch("restart");

    const killed = run("start", ["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--approve", "--json"], { ...env, COLLECTIONS_KILL_AFTER_DISPATCH: "1" });
    expect(killed.code).toBe(137);
    expect(killed.stdout).toBe("");

    const db = new DatabaseSync(join(env["COLLECTIONS_STATE_DIR"]!, "state.db"));
    expect(db.prepare("SELECT state FROM executions").all()).toEqual([{ state: "executing" }]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(1);
    db.close();

    // resume: the outbox is `sent`, so nothing is re-issued; the receivable is looked at and found registered, waiting for its payer.
    const resumed = run("resume", ["--json"], env);
    expect(resumed.code).toBe(0);
    const r = JSON.parse(resumed.stdout.trim()) as { resumed: Array<{ state: string; reason: string | null; charge_ids: string[] }> };
    expect(r.resumed).toHaveLength(1);
    expect(r.resumed[0]).toMatchObject({ state: "executing", reason: "awaiting_settlement" });
    expect(r.resumed[0]?.charge_ids[0]).toMatch(/^chg_stub_/);

    // poll: the fixture payer pays on the next look; the record is fetched; the payer is told once.
    const polled = run("poll", ["--json"], env);
    expect(polled.code).toBe(0);
    const p = JSON.parse(polled.stdout.trim()) as { polled: Array<{ state: string; timed_out: boolean }> };
    expect(p.polled).toEqual([expect.objectContaining({ state: "settled", timed_out: false })]);

    const db2 = new DatabaseSync(join(env["COLLECTIONS_STATE_DIR"]!, "state.db"));
    expect((db2.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(1);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'commerce.charge.paid'").get() as { n: number }).n).toBe(1);
    expect((db2.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'message.debtor'").get() as { n: number }).n).toBe(1);
    expect(db2.prepare("SELECT state FROM executions").all()).toEqual([{ state: "settled" }]);
    db2.close();

    const runsDir = env["COLLECTIONS_RUNS_DIR"]!;
    const receipts = readdirSync(runsDir).flatMap((d) => (existsSync(join(runsDir, d, "receipts")) ? readdirSync(join(runsDir, d, "receipts")) : []));
    expect(receipts).toHaveLength(1);

    const again = run("poll", ["--json"], env);
    expect(JSON.parse(again.stdout.trim())).toEqual({ polled: [] });
  });
});

describe("npm run rerun <run-id>", () => {
  it("reproduces a recorded run without network, with the same state sequence, including an expired receivable", () => {
    const env = scratch("rerun");
    // No --simulate-payer: the fixture payer lets it expire at the second look; the recorded run is a failed one.
    const first = run("start", ["--input", "pode emitir", "--transcript", "test/fixtures/accept-1103.transcript.jsonl", "--approve", "--json"], { ...env, COLLECTIONS_STUB_PAYER: "expires" });
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout.trim()) as { run_id: string; executions: Array<{ state: string; reason: string | null }> };
    expect(payload.executions[0]).toMatchObject({ state: "failed", reason: "charge_expired" });
    const rerun = run("rerun", [payload.run_id, "--json"], env);
    expect(rerun.code).toBe(0);
    const r = JSON.parse(rerun.stdout.trim()) as { same_states: boolean; original: string[]; rerun: string[] };
    expect(r.same_states).toBe(true);
    expect(r.original).toEqual(["awaiting_approval", "approved", "executing", "failed"]);
  });
});

describe("npm run check", () => {
  it("is green for the shipped agent and prints JSON with --json", () => {
    const out = run("check", ["--json"], {});
    expect(out.code).toBe(0);
    const report = JSON.parse(out.stdout.trim()) as { ok: boolean; agent: string; findings: unknown[] };
    expect(report).toMatchObject({ ok: true, agent: "collections-agent" });
  });
});

describe("npm run approve / deny <execution-id>", () => {
  it("decides an execution left awaiting, produces the artifact, issues, and waits for the payer", () => {
    const env = scratch("decide");
    const left = run("start", ["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--json"], env);
    expect(left.code).toBe(0);
    const payload = JSON.parse(left.stdout.trim()) as { executions: Array<{ id: string; state: string }> };
    expect(payload.executions[0]?.state).toBe("awaiting_approval");
    const id = payload.executions[0]!.id;

    const approved = run("approve", [id, "--user", "usr_gerente", "--simulate-payer", "--json"], env);
    expect(approved.code).toBe(0);
    const out = JSON.parse(approved.stdout.trim()) as { state: string; approval_id: string | null; charge_ids: string[]; receipt_ids: string[]; bundle_dir: string };
    expect(out.state).toBe("settled");
    expect(out.approval_id).toMatch(/^apr_/);
    expect(out.charge_ids).toHaveLength(1);
    expect(out.receipt_ids).toHaveLength(1);
    const artifacts = JSON.parse(readFileSync(join(AGENT_DIR, out.bundle_dir, "approval.json"), "utf8")) as Array<{ approver: { type: string; id: string } }>;
    expect(artifacts[0]?.approver).toEqual({ type: "person", id: "usr_gerente", channel: "terminal" });

    const again = run("approve", [id, "--json"], env);
    expect(again.code).toBe(1);
  });

  it("deny leaves a terminal denied execution and issues nothing", () => {
    const env = scratch("deny");
    const left = run("start", ["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--json"], env);
    const id = (JSON.parse(left.stdout.trim()) as { executions: Array<{ id: string }> }).executions[0]!.id;
    const denied = run("deny", [id, "--json"], env);
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.stdout.trim())).toMatchObject({ state: "denied", reason: "denied_by_approver", charge_ids: [] });
    const db = new DatabaseSync(join(env["COLLECTIONS_STATE_DIR"]!, "state.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get() as { n: number }).n).toBe(0);
    db.close();
  });
});
