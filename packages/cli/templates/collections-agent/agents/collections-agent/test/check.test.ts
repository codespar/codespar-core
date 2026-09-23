import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgent } from "@codespar/agent-core";

const AGENT_DIR = resolve(import.meta.dirname, "..");

function copyAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "collections-check-"));
  for (const f of ["agent.yaml", "SYSTEM_PROMPT.md", "tools.json", "guardrails.json", "mandate.example.json", "AGENTS.md", "CLAUDE.md", "README.md", "runbook.md", ".env.example"]) cpSync(join(AGENT_DIR, f), join(dir, f));
  cpSync(join(AGENT_DIR, "scenarios"), join(dir, "scenarios"), { recursive: true });
  cpSync(join(AGENT_DIR, "evals"), join(dir, "evals"), { recursive: true });
  return dir;
}

const codes = (dir: string) => checkAgent(dir).findings.filter((f) => f.level === "error").map((f) => f.code);

describe("npm run check: the manifest is the index", () => {
  it("passes on the shipped agent", () => {
    expect(codes(AGENT_DIR)).toEqual([]);
  });

  it("fails when the charge tool is dropped, or when the manifest stops declaring the receivables maturity", () => {
    const dir = copyAgent();
    const t = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: Array<{ effect: string }> };
    writeFileSync(join(dir, "tools.json"), JSON.stringify({ ...t, meta_tools: t.meta_tools.filter((x) => x.effect !== "charge") }));
    expect(codes(dir)).toContain("tools_contradict_manifest");
    const again = copyAgent();
    writeFileSync(join(again, "agent.yaml"), readFileSync(join(again, "agent.yaml"), "utf8").replace("  bolepix-receivables: sandbox\n", ""));
    expect(codes(again)).toContain("tools_contradict_manifest");
  });

  it("fails when guardrails contradict the manifest, or when the prompt names a tool tools.json does not have", () => {
    const dir = copyAgent();
    const g = JSON.parse(readFileSync(join(dir, "guardrails.json"), "utf8")) as { escalate_above: { amount: number } };
    g.escalate_above.amount = 1;
    writeFileSync(join(dir, "guardrails.json"), JSON.stringify(g));
    expect(codes(dir)).toContain("guardrails_contradict_manifest");
    writeFileSync(join(dir, "SYSTEM_PROMPT.md"), readFileSync(join(dir, "SYSTEM_PROMPT.md"), "utf8") + "\nYou may also call codespar_pay.\n");
    expect(codes(dir)).toContain("prompt_contradicts_tools");
  });

  it("fails when AGENTS.md and CLAUDE.md diverge, or when a README overclaims", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra line\n");
    expect(codes(dir)).toContain("agents_md_diverges");
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nThe record is third-party verifiable.\n");
    expect(codes(dir)).toContain("doc_overclaims");
  });
});
