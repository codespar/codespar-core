/**
 * `codespar agent run` and `codespar eval` at the process level, against
 * the fixture kit in `fixtures/agent-kit` (a package.json whose scripts
 * echo what they received). No network, no model, no @codespar/agent-core:
 * what is under test is the delegation, and the delegation is the point.
 *
 * ## The gate (spec v5.1.1 §15, "Mesmo resultado")
 *
 * `codespar agent run <dir> --input X --json` and `npm start -- --input X
 * --json` in that directory must give the SAME output. The first case
 * below runs both and compares stdout byte for byte. It can, because the
 * CLI does not re-implement the entry: it spawns the directory's own
 * `npm start` with the same arguments.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../dist/index.js");
const KIT = join(HERE, "fixtures/agent-kit");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function cli(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "codespar-agent-"));
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: home,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "", ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function npmStart(args: string[]) {
  const r = spawnSync(NPM, ["start", "--silent", "--", ...args], {
    cwd: KIT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    shell: process.platform === "win32",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("codespar agent run", () => {
  it("GATE: gives the same output as `npm start -- --input` in the agent directory", () => {
    const viaCli = cli(["agent", "run", KIT, "--input", "pague a escola de outubro", "--json"]);
    const viaNpm = npmStart(["--input", "pague a escola de outubro", "--json"]);

    expect(viaCli.status).toBe(0);
    expect(viaNpm.status).toBe(0);
    expect(viaCli.stdout).toBe(viaNpm.stdout);
    const doc = JSON.parse(viaCli.stdout);
    expect(doc.input).toBe("pague a escola de outubro");
    expect(doc.argv).toEqual(["--input", "pague a escola de outubro", "--json"]);
  }, 90_000);

  it("with --json, stdout is the agent's document and nothing else", () => {
    const r = cli(["--json", "agent", "run", KIT, "--input", "x", "--approve"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).argv).toEqual(["--input", "x", "--approve", "--json"]);
    // The npm banner (`> name@version start`) and the CLI's own info line
    // both go elsewhere: one is silenced, the other is on stderr.
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
  }, 90_000);

  it("without --json, stdout is the agent's human reply and the info line is on stderr", () => {
    const r = cli(["agent", "run", KIT, "--input", "x", "--deny"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("echo: x\n");
    expect(r.stderr).toContain("kit-under-test@0.0.1");
    expect(r.stderr).toContain("[kit] start --input x --deny");
  }, 90_000);

  it("the exit code is the agent's own (3 = an execution left in flight)", () => {
    const r = cli(["agent", "run", KIT, "--input", "leave one in flight", "--json"]);
    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout).input).toBe("leave one in flight");
  }, 90_000);

  it("refuses a directory whose agent.yaml is not schema 1, with a stable code", () => {
    const r = cli(["--json", "agent", "run", join(HERE, "fixtures/agent-kit-schema-2")]);
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.error.kind).toBe("cli");
    expect(doc.error.code).toBe("agent_manifest_unsupported_schema");
    expect(r.stderr).toContain("schema 2");
  }, 60_000);

  it("refuses a directory with no agent.yaml, with a stable code", () => {
    const r = cli(["--json", "agent", "run", mkdtempSync(join(tmpdir(), "codespar-empty-"))]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("agent_manifest_missing");
  }, 60_000);

  it("refuses --approve with --deny before spawning anything", () => {
    const r = cli(["--json", "agent", "run", KIT, "--input", "x", "--approve", "--deny"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("agent_decision_conflict");
    expect(r.stderr).not.toContain("[kit] start");
  }, 60_000);
});

describe("codespar eval", () => {
  it("reports one line per case and exits 0 when every case passes", () => {
    const r = cli(["eval", KIT]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toEqual([
      "ok   check/kit-under-test",
      "ok   adversarial/beneficiary-swap",
      "ok   adversarial/exfiltration",
      "ok   scenario/happy-path [human]",
      "ok   scenario/happy-path [mandate]",
      "✓ 5 case(s) passed",
    ]);
    // The kit's own progress lines reach the terminal, on stderr.
    expect(r.stderr).toContain("[kit] check ok");
    expect(r.stderr).toContain("[kit] eval ok");
  }, 90_000);

  it("--json: one document with the per-case list and both kit documents verbatim", () => {
    const r = cli(["--json", "eval", KIT]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(true);
    expect(doc.agent).toBe("kit-under-test");
    expect(doc.cases).toHaveLength(5);
    expect(doc.check.findings[0].code).toBe("just_a_warning");
    expect(doc.eval.scenarios[1].receipts).toBe(1);
  }, 90_000);

  it("exits 1 and names the failing case when the eval suite fails", () => {
    const r = cli(["--json", "eval", KIT], { KIT_EVAL_FAIL: "1" });
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.ok).toBe(false);
    expect(doc.cases.filter((k: { ok: boolean }) => !k.ok)).toEqual([
      { suite: "adversarial", name: "exfiltration", ok: false, failures: ["codespar_wallet was called"] },
    ]);
  }, 90_000);

  it("a failing check does not stop the eval suite from running, and fails the run", () => {
    const r = cli(["eval", KIT], { KIT_CHECK_FAIL: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL check/kit-under-test — tools_contradict_manifest: tools.json disagrees");
    expect(r.stdout).toContain("ok   scenario/happy-path [mandate]");
    expect(r.stdout).toContain("✗ 1 of 5 case(s) failed");
  }, 90_000);

  it("refuses a directory that is not an agent, with the same code as `agent run`", () => {
    const r = cli(["--json", "eval", mkdtempSync(join(tmpdir(), "codespar-empty-"))]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("agent_manifest_missing");
  }, 60_000);
});
