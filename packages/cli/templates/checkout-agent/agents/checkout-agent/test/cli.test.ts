/**
 * The contracts that need a real process: `--json` on stdout and nothing
 * else, the live-key refusal, the clock pin, the restart after the issuance
 * followed by `resume` and `poll`, `rerun`, `approve`/`deny`, and `check`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const ORDER = ["--input", "oi, sou a Marina, quero duas aulas avulsas, fecha e gera o pagamento", "--transcript", "test/fixtures/order-marina.transcript.jsonl"];

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(NODE, [BIN, command, ...args], {
    cwd: AGENT_DIR,
    // Pinned inside the service hours (#16): these processes must not depend on the hour the suite runs at. A test overrides it.
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: "2026-09-23T14:00:00-03:00", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function scratch(label: string): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), `checkout-${label}-`));
  return { CHECKOUT_STATE_DIR: stateDir, CHECKOUT_RUNS_DIR: join(stateDir, "runs") };
}

const count = (env: Record<string, string>, sql: string) => {
  const db = new DatabaseSync(join(env["CHECKOUT_STATE_DIR"]!, "state.db"));
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

type Payload = {
  actor: { type: string };
  carts: Array<{ cart_id: string; cart_hash: string; total_minor: number }>;
  executions: Array<{ id: string; state: string; reason: string | null; payable?: boolean | null; cart_id: string | null; cart_hash: string | null; total_minor: number; due_date: string | null; charge_id: string | null; pix_copy_paste: string | null }>;
  receipts: string[];
  invoices: Array<{ sale_execution_id: string; state: string; reason: string | null; attempts: number }>;
};

describe("npm start -- --input ... --json (the five-minute contract)", () => {
  it("one command: the cart, the order, the charge and the payment, with cart_id, cart_hash, total_minor, state, charge_id and pix_copy_paste on stdout and nothing else", () => {
    const out = run("start", [...ORDER, "--approve", "--simulate-payer", "--json"], scratch("json"));
    expect(out.code).toBe(0);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as Payload;
    expect(payload.actor.type).toBe("agent");
    expect(payload.executions).toHaveLength(1);
    const [e] = payload.executions;
    expect(e).toMatchObject({ state: "settled", cart_id: "cart-1", total_minor: 20000, due_date: "2026-09-23" });
    expect(e!.cart_hash).toBe(payload.carts[0]!.cart_hash);
    expect(e!.cart_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(e!.charge_id).toMatch(/^chg_stub_/);
    expect(payload.receipts).toHaveLength(1);
    // The paid order opened its NFS-e, a separate execution, and the stub issuer accepted it.
    expect(payload.invoices).toEqual([expect.objectContaining({ sale_execution_id: e!.id, state: "accepted", reason: null, attempts: 1 })]);
    // The QR and the people go to stderr.
    expect(out.stderr).toContain("copia e cola");
  });

  it("an order issued and not yet paid hands the payable copy-and-paste to the caller, and exits 3 (open)", () => {
    const out = run("start", [...ORDER, "--approve", "--json"], { ...scratch("unpaid"), CHECKOUT_STUB_PAYER: "never" });
    expect(out.code).toBe(3);
    const [e] = (JSON.parse(out.stdout.trim()) as Payload).executions;
    expect(e).toMatchObject({ state: "executing", reason: "awaiting_settlement", cart_id: "cart-1", total_minor: 20000, payable: true });
    expect(e!.pix_copy_paste).toContain("br.gov.bcb.pix");
  });

  it("at 20:30 America/Sao_Paulo the order is denied (outside_hours) and nothing is issued", () => {
    const env = scratch("night");
    const out = run("start", [...ORDER, "--approve", "--simulate-payer", "--json", "--now", "2026-09-23T20:30:00-03:00"], env);
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.stdout.trim()) as Payload;
    expect(payload.executions[0]).toMatchObject({ state: "denied", reason: "outside_hours", charge_id: null });
    expect(count(env, "SELECT COUNT(*) AS n FROM stub_rail_attempts")).toBe(0);
  });

  it("refuses a key outside csk_test_ before anything else", () => {
    const out = run("start", [...ORDER, "--json"], { ...scratch("live"), CODESPAR_API_KEY: ["csk", "live", "0000000000"].join("_") });
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("csk_test_");
  });
});

describe("section 10: restart after the issuance, then resume and poll", () => {
  it("one charge, one settlement, never two", () => {
    const env = scratch("restart");
    const killed = run("start", [...ORDER, "--approve", "--json"], { ...env, CHECKOUT_KILL_AFTER_DISPATCH: "1" });
    expect(killed.code).toBe(137);
    expect(killed.stdout).toBe("");
    expect(count(env, "SELECT COUNT(*) AS n FROM stub_rail_attempts")).toBe(1);

    const resumed = run("resume", ["--json"], env);
    expect(resumed.code).toBe(0);
    const r = JSON.parse(resumed.stdout.trim()) as { resumed: Array<{ state: string; reason: string | null; charge_ids: string[] }> };
    expect(r.resumed).toEqual([expect.objectContaining({ state: "executing", reason: "awaiting_settlement" })]);

    const polled = run("poll", ["--json"], env);
    expect(polled.code).toBe(0);
    expect((JSON.parse(polled.stdout.trim()) as { polled: Array<{ state: string }> }).polled).toEqual([expect.objectContaining({ state: "settled" })]);
    expect(count(env, "SELECT COUNT(*) AS n FROM stub_rail_attempts")).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM events WHERE type = 'commerce.charge.paid'")).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM events WHERE type = 'message.debtor'")).toBe(1);
    // The order settled in `poll`, and `poll` is where its NFS-e went out: once.
    expect(count(env, "SELECT COUNT(*) AS n FROM events WHERE type = 'invoice.dispatch'")).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM outbox WHERE kind = 'nfse.issue' AND status = 'done'")).toBe(1);
    const runsDir = env["CHECKOUT_RUNS_DIR"]!;
    expect(readdirSync(runsDir).flatMap((d) => (existsSync(join(runsDir, d, "receipts")) ? readdirSync(join(runsDir, d, "receipts")) : []))).toHaveLength(1);
  });
});

describe("npm run rerun <run-id>", () => {
  it("reproduces a recorded run without network, with the same state sequence, including an expired charge", () => {
    const env = scratch("rerun");
    const first = run("start", [...ORDER, "--approve", "--json"], { ...env, CHECKOUT_STUB_PAYER: "expires" });
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout.trim()) as Payload & { run_id: string };
    expect(payload.executions[0]).toMatchObject({ state: "failed", reason: "charge_expired" });
    const rerun = run("rerun", [payload.run_id, "--json"], env);
    expect(rerun.code).toBe(0);
    const r = JSON.parse(rerun.stdout.trim()) as { same_states: boolean; original: string[] };
    expect(r.same_states).toBe(true);
    expect(r.original).toEqual(["awaiting_approval", "approved", "executing", "failed"]);
  });
});

describe("npm run approve / deny <execution-id>: the attendant confirms; the charge waits for the customer", () => {
  it("approve produces the artifact and leaves the order approved: nothing is issued until the customer asks", () => {
    const env = scratch("decide");
    const left = run("start", [...ORDER, "--json"], env);
    expect(left.code).toBe(0);
    const payload = JSON.parse(left.stdout.trim()) as Payload;
    expect(payload.executions[0]?.state).toBe("awaiting_approval");
    const approved = run("approve", [payload.executions[0]!.id, "--user", "usr_gerente", "--json"], env);
    expect(approved.code).toBe(0);
    expect(JSON.parse(approved.stdout.trim())).toMatchObject({ state: "approved", approval_id: expect.stringMatching(/^apr_/), charge_ids: [] });
    expect(count(env, "SELECT COUNT(*) AS n FROM stub_rail_attempts")).toBe(0);
  });

  it("deny leaves a terminal denied order and issues nothing", () => {
    const env = scratch("deny");
    const left = run("start", [...ORDER, "--json"], env);
    const id = (JSON.parse(left.stdout.trim()) as Payload).executions[0]!.id;
    const denied = run("deny", [id, "--json"], env);
    expect(denied.code).toBe(0);
    expect(JSON.parse(denied.stdout.trim())).toMatchObject({ state: "denied", reason: "denied_by_approver", charge_ids: [] });
    expect(count(env, "SELECT COUNT(*) AS n FROM stub_rail_attempts")).toBe(0);
  });
});

describe("npm run check", () => {
  it("is green for the shipped agent and prints JSON with --json", () => {
    const out = run("check", ["--json"], {});
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout.trim())).toMatchObject({ ok: true, agent: "checkout-agent" });
  });
});
