/**
 * `codespar-agent check [--json]`: the manifest-coherence gate of section 4.3.
 *
 * The files are the core's to check (`checkAgent`). The string tables are
 * checked here, because they are code: the runner has the agent's kit loaded
 * and the core, which reads files, does not.
 */
import { stderr, stdout } from "node:process";
import { CORE_STRINGS, checkAgent, tableGaps, type CheckFinding } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import type { AgentKit } from "../kit.js";

/**
 * Every key of the shared table and of the kit's, in every locale. A key that
 * one locale lacks is a line an agent run in that locale would print as
 * `undefined`; it fails here, before anybody runs it.
 */
export function checkStrings(kit: Pick<AgentKit, "strings">): CheckFinding[] {
  return [...tableGaps("CORE_STRINGS", CORE_STRINGS), ...tableGaps("kit.strings", kit.strings)].map((message) => ({ level: "error" as const, code: "strings_incomplete", message }));
}

export function check(agent: Agent, argv: string[]): number {
  const json = argv.includes("--json");
  const files = checkAgent(agent.dir);
  const findings = [...files.findings, ...checkStrings(agent.kit)];
  const report = { ...files, ok: findings.every((f) => f.level !== "error"), findings };
  if (json) stdout.write(JSON.stringify(report) + "\n");
  for (const f of report.findings) stderr.write(`${f.level === "error" ? "ERROR" : "warn "} ${f.code}: ${f.message}\n`);
  stderr.write(report.ok ? `check ok: ${report.agent} agrees with its agent.yaml\n` : `check FAILED for ${report.agent ?? "agent"}\n`);
  return report.ok ? 0 : 1;
}
