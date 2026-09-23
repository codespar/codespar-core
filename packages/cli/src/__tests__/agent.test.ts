/**
 * `codespar agent run` and `codespar eval`, the process-free half: how a
 * directory is recognised as an agent, how the CLI's flags map onto the
 * agent's own argument spelling, and how two JSON documents become one
 * per-case report. The process-level half is `agent-process.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../config.js";
import {
  agentRunArgs,
  resolveAgentDir,
  summariseEval,
  topLevelScalars,
} from "../commands/agent.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof CliError) return err.code;
    throw err;
  }
  return undefined;
}

describe("topLevelScalars", () => {
  it("reads the top-level `key: value` lines, quotes and comments stripped", () => {
    const fields = topLevelScalars(
      ["# header", "schema: 1", 'version: "0.1.0"', "name: bills-agent   # trailing", "escalate_above:", "  amount: 150000", 'mcp: "@codespar/mcp@0.5.8"'].join("\n"),
    );
    expect(fields).toEqual({ schema: "1", version: "0.1.0", name: "bills-agent", mcp: "@codespar/mcp@0.5.8" });
  });

  it("CONTROL: a nested key is not a top-level field", () => {
    expect(topLevelScalars("escalate_above:\n  amount: 1\n")["amount"]).toBeUndefined();
  });
});

describe("resolveAgentDir", () => {
  it("accepts a schema: 1 directory and reads its name, version and scripts", () => {
    const agent = resolveAgentDir(join(FIXTURES, "agent-kit"));
    expect(agent.name).toBe("kit-under-test");
    expect(agent.version).toBe("0.0.1");
    expect(Object.keys(agent.scripts).sort()).toEqual(["check", "eval", "start"]);
    expect(agent.manifestPath.endsWith("agent.yaml")).toBe(true);
  });

  it("refuses a directory with no agent.yaml with a stable code", () => {
    const empty = mkdtempSync(join(tmpdir(), "codespar-not-an-agent-"));
    expect(code(() => resolveAgentDir(empty))).toBe("agent_manifest_missing");
  });

  it("refuses a schema this CLI does not know with a stable code", () => {
    expect(code(() => resolveAgentDir(join(FIXTURES, "agent-kit-schema-2")))).toBe("agent_manifest_unsupported_schema");
  });

  it("refuses a manifest that declares no schema at all", () => {
    const dir = mkdtempSync(join(tmpdir(), "codespar-no-schema-"));
    writeFileSync(join(dir, "agent.yaml"), "name: nameless\nversion: 0.0.1\n");
    expect(code(() => resolveAgentDir(dir))).toBe("agent_manifest_schema_missing");
  });

  it("refuses a manifest with no package.json beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "codespar-no-package-"));
    writeFileSync(join(dir, "agent.yaml"), "schema: 1\nname: lonely\nversion: 0.0.1\n");
    expect(code(() => resolveAgentDir(dir))).toBe("agent_package_missing");
  });
});

describe("agentRunArgs", () => {
  it("spells the flags the way a kit's src/main.ts parses them", () => {
    expect(agentRunArgs({ input: "pague a escola de outubro", approve: true, json: true })).toEqual([
      "--input",
      "pague a escola de outubro",
      "--approve",
      "--json",
    ]);
    expect(agentRunArgs({ deny: true })).toEqual(["--deny"]);
    expect(agentRunArgs({})).toEqual([]);
  });

  it("refuses --approve together with --deny", () => {
    expect(code(() => agentRunArgs({ approve: true, deny: true }))).toBe("agent_decision_conflict");
  });
});

describe("summariseEval", () => {
  const check = { ok: true, agent: "bills-agent", findings: [{ level: "warning", code: "w", message: "warn only" }] };
  const evaluation = {
    ok: true,
    adversarial: [{ name: "beneficiary-swap", ok: true, failures: [] }],
    scenarios: [
      { name: "happy-path", mode: "human", ok: true, failures: [] },
      { name: "happy-path", mode: "mandate", ok: true, failures: [] },
    ],
  };

  it("positive control: one case per adversarial case, per scenario run, plus the check", () => {
    const report = summariseEval(check, evaluation);
    expect(report.ok).toBe(true);
    expect(report.agent).toBe("bills-agent");
    expect(report.cases.map((k) => `${k.suite}/${k.name}${k.mode ? `[${k.mode}]` : ""}`)).toEqual([
      "check/bills-agent",
      "adversarial/beneficiary-swap",
      "scenario/happy-path[human]",
      "scenario/happy-path[mandate]",
    ]);
    // A warning is reported by the kit and never fails the check.
    expect(report.cases[0]!.failures).toEqual([]);
  });

  it("negative control: a failing scenario fails the report and names why", () => {
    const report = summariseEval(check, {
      ...evaluation,
      ok: false,
      scenarios: [{ name: "cap-exceeded", mode: "mandate", ok: false, failures: ["expected denied, got settled"] }],
    });
    expect(report.ok).toBe(false);
    expect(report.cases.filter((k) => !k.ok)).toEqual([
      { suite: "scenario", name: "cap-exceeded", mode: "mandate", ok: false, failures: ["expected denied, got settled"] },
    ]);
  });

  it("negative control: a failing check is a failing case with its error findings", () => {
    const report = summariseEval(
      { ok: false, agent: "bills-agent", findings: [{ level: "error", code: "tools_invalid", message: "bad" }] },
      evaluation,
    );
    expect(report.ok).toBe(false);
    expect(report.cases[0]).toEqual({ suite: "check", name: "bills-agent", ok: false, failures: ["tools_invalid: bad"] });
  });

  it("negative control: a document that says ok: false with no listed failure still fails", () => {
    expect(summariseEval(check, { ...evaluation, ok: false }).ok).toBe(false);
  });
});
