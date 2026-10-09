/**
 * The replayed reply of `happy-path` is the same sentence whatever the run
 * does with the payment it proposed. It promises a result, which every run
 * has, and no receipt, which only a settled one has.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
/** Inside the escalation hours and inside the example mandate's validity, whatever the day and the shell the suite runs in. */
const DAYTIME = "2026-09-23T14:00:00-03:00";
/** The line the terminal prints for a receipt that exists, in the locale these runs are pinned to. */
const RECEIPT_LINE = /^\s*recibo: .*rcpt_stub_/;

interface Payload {
  reply: string;
  executions: Array<{ state: string; escalation: { trigger: string } | null; receipt_ids: string[] }>;
  receipts: string[];
}

function scratch(): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), "bills-reply-"));
  return { BILLS_STATE_DIR: stateDir, BILLS_RUNS_DIR: join(stateDir, "runs") };
}

/** One `npm start`, in pt-BR and on a pinned clock; `--now` in `args` overrides the clock. */
function start(args: string[], env: Record<string, string> = scratch()) {
  const result = spawnSync(process.execPath, [BIN, "start", "--locale", "pt-BR", ...args], {
    cwd: AGENT_DIR,
    env: { ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", CODESPAR_AGENT_NOW: DAYTIME, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, payload: () => JSON.parse(result.stdout.trim()) as Payload };
}

const receiptLines = (terminal: string) => terminal.split("\n").filter((line) => RECEIPT_LINE.test(line));

describe("npm start -- --input: the replayed reply against what the run did", () => {
  const INPUT = ["--input", "pague a escola de outubro", "--json"];

  it.each([
    { name: "a person denied", flags: ["--deny"], state: "denied" },
    { name: "nobody decided", flags: [], state: "awaiting_approval" },
  ])("cites no receipt when $name, and there is none", ({ flags, state }) => {
    const out = start([...INPUT, ...flags]);
    const payload = out.payload();
    expect(payload.executions.map((e) => e.state)).toEqual([state]);
    expect(payload.receipts).toEqual([]);
    expect(payload.reply).toContain("O resultado está no terminal.");
    expect(payload.reply).not.toMatch(/recibo/i);
    expect(receiptLines(out.stderr)).toEqual([]);
  });

  it("says the same when the payment settled, and the receipt is the terminal's own line", () => {
    const out = start([...INPUT, "--approve"]);
    expect(out.code).toBe(0);
    const payload = out.payload();
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(payload.receipts).toHaveLength(1);
    expect(payload.reply).toContain("O resultado está no terminal.");
    expect(payload.reply).not.toMatch(/recibo/i);
    // The receipt is named once, by the terminal, on the line that gives its path.
    expect(receiptLines(out.stderr)).toHaveLength(1);
  });

  it("a payment inside the mandate that the hour sends to a human is not said to be paid", () => {
    // The payee has a settled payment under this mandate first, so what escalates the next one is the hour and not `new_beneficiary`, which is checked before it.
    const env = scratch();
    const seed = start(["--mode", "mandate", "--input", "paga 400 reais pra escola (material)", "--transcript", "test/fixtures/material-400.transcript.jsonl", "--approve", "--json"], env);
    expect(seed.payload().executions[0]).toMatchObject({ state: "settled", escalation: { trigger: "new_beneficiary" } });

    const night = start(["--mode", "mandate", "--input", "e mais 300 reais pra escola, a excursao", "--transcript", "test/fixtures/excursao-300.transcript.jsonl", "--now", "2026-09-23T23:00:00-03:00", "--json"], env);
    const payload = night.payload();
    expect(payload.executions).toHaveLength(1);
    expect(payload.executions[0]).toMatchObject({ state: "awaiting_approval", escalation: { trigger: "outside_hours" }, receipt_ids: [] });
    expect(payload.reply).not.toMatch(/paguei|recibo/i);
    expect(receiptLines(night.stderr)).toEqual([]);
  });
});
