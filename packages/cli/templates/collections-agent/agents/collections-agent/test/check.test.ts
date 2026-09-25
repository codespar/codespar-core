import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  cpSync(join(AGENT_DIR, "channels"), join(dir, "channels"), { recursive: true });
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

  it("fails when a declared channel ships no conversation, and when a shipped one is not declared", () => {
    const dropped = copyAgent();
    rmSync(join(dropped, "channels"), { recursive: true, force: true });
    expect(codes(dropped)).toContain("channels_not_shipped");

    const undeclared = copyAgent();
    writeFileSync(join(undeclared, "agent.yaml"), readFileSync(join(undeclared, "agent.yaml"), "utf8").replace(/^channels:.*$/m, "channels: [terminal]"));
    expect(codes(undeclared)).toContain("channels_undeclared");
  });

  it("fails on a conversation the simulator could not drive: a bad contact, a missing turn, a name that is not the file's", () => {
    const badContact = copyAgent();
    const path = join(badContact, "channels/whatsapp/acordo-1042.json");
    const script = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...script, contact: "11987654321" }));
    expect(codes(badContact)).toContain("channels_script_invalid");

    const noTurns = copyAgent();
    const turnsPath = join(noTurns, "channels/whatsapp/acordo-1042.json");
    writeFileSync(turnsPath, JSON.stringify({ ...JSON.parse(readFileSync(turnsPath, "utf8")), turns: [] }));
    expect(codes(noTurns)).toContain("channels_script_invalid");

    const misnamed = copyAgent();
    const namePath = join(misnamed, "channels/whatsapp/acordo-1042.json");
    writeFileSync(namePath, JSON.stringify({ ...JSON.parse(readFileSync(namePath, "utf8")), name: "outro-acordo" }));
    expect(codes(misnamed)).toContain("channels_script_invalid");
  });

  it("fails when the terminal channel is dropped: every agent has one and `npm start` opens it", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "agent.yaml"), readFileSync(join(dir, "agent.yaml"), "utf8").replace(/^channels:.*$/m, "channels: [whatsapp]"));
    expect(codes(dir)).toContain("channels_terminal_missing");
  });

  it("fails when AGENTS.md and CLAUDE.md diverge, or when a README overclaims", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra line\n");
    expect(codes(dir)).toContain("agents_md_diverges");
    // This agent mints receivables, and a paid charge carries no chain and no signature, so the claim is refused in its own README even though that README names Ed25519.
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nThe record is third-party verifiable.\n");
    expect(codes(dir)).toContain("doc_overclaims");
  });

  it("refuses a maturity this agent's records cannot carry", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "agent.yaml"), readFileSync(join(dir, "agent.yaml"), "utf8").replace("receipt-verification: blocked", "receipt-verification: sandbox"));
    expect(codes(dir)).toContain("maturity_overclaims");
  });
});
