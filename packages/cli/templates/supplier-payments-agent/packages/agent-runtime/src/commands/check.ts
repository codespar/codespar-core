/**
 * `codespar-agent check [--json]`: the manifest-coherence gate of section 4.3.
 */
import { stderr, stdout } from "node:process";
import { checkAgent } from "@codespar/agent-core";
import type { Agent } from "../agent.js";

export function check(agent: Agent, argv: string[]): number {
  const json = argv.includes("--json");
  const report = checkAgent(agent.dir);
  if (json) stdout.write(JSON.stringify(report) + "\n");
  for (const f of report.findings) stderr.write(`${f.level === "error" ? "ERROR" : "warn "} ${f.code}: ${f.message}\n`);
  stderr.write(report.ok ? `check ok: ${report.agent} agrees with its agent.yaml\n` : `check FAILED for ${report.agent ?? "agent"}\n`);
  return report.ok ? 0 : 1;
}
