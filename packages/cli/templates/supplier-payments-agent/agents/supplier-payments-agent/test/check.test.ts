import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgent } from "@codespar/agent-core";

const AGENT_DIR = resolve(import.meta.dirname, "..");

function copyAgent(): string {
  const dir = mkdtempSync(join(tmpdir(), "supplier-check-"));
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

  it("fails when guardrails contradict the manifest", () => {
    const dir = copyAgent();
    const g = JSON.parse(readFileSync(join(dir, "guardrails.json"), "utf8")) as { approval: string; escalate_above: { amount: number } };
    g.approval = "mandate";
    writeFileSync(join(dir, "guardrails.json"), JSON.stringify(g));
    expect(codes(dir)).toContain("guardrails_contradict_manifest");
    g.approval = "human";
    g.escalate_above.amount = 999;
    writeFileSync(join(dir, "guardrails.json"), JSON.stringify(g));
    expect(codes(dir)).toContain("guardrails_contradict_manifest");
  });

  it("fails when the prompt names a tool tools.json does not have, or when tools.json drops the payment tool", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "SYSTEM_PROMPT.md"), readFileSync(join(dir, "SYSTEM_PROMPT.md"), "utf8") + "\nYou may also call codespar_wallet.\n");
    expect(codes(dir)).toContain("prompt_contradicts_tools");
    const t = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: Array<{ effect: string }> };
    t.meta_tools = t.meta_tools.filter((x) => x.effect !== "payment");
    writeFileSync(join(dir, "tools.json"), JSON.stringify(t));
    expect(codes(dir)).toContain("tools_contradict_manifest");
  });

  it("fails when AGENTS.md and CLAUDE.md diverge", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "CLAUDE.md"), readFileSync(join(dir, "CLAUDE.md"), "utf8") + "\nextra line\n");
    expect(codes(dir)).toContain("agents_md_diverges");
  });

  it("fails when mcp, cli or schema are missing", () => {
    for (const field of ["mcp", "cli", "schema"]) {
      const dir = copyAgent();
      writeFileSync(join(dir, "agent.yaml"), readFileSync(join(dir, "agent.yaml"), "utf8").split("\n").filter((l) => !l.startsWith(`${field}:`)).join("\n"));
      expect(codes(dir)).toContain("manifest_field_missing");
    }
  });

  it("fails when a doc claims third-party verifiability and never says which signature it means", () => {
    const dir = copyAgent();
    // The claim with no mechanism named: true of the Ed25519 seal on a receipt, false of the approval artifact and of every receipt sealed before it.
    writeFileSync(join(dir, "README.md"), "# supplier-payments-agent\n\nO recibo é verificável por terceiro.\n");
    expect(codes(dir)).toContain("doc_overclaims");
    // The same claim, with the mechanism named: allowed, and what the shipped README does.
    writeFileSync(join(dir, "README.md"), "# supplier-payments-agent\n\nO recibo é verificável por terceiro: a assinatura Ed25519 confere contra as chaves públicas.\n");
    expect(codes(dir)).not.toContain("doc_overclaims");
  });


  it("refuses the claim, mechanism named and all, when the agent itself says receipt-verification is blocked", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\nThe receipt is third-party verifiable: the Ed25519 signature checks against the published keys.\n");
    expect(codes(dir)).not.toContain("doc_overclaims");
    writeFileSync(join(dir, "agent.yaml"), readFileSync(join(dir, "agent.yaml"), "utf8").replace("receipt-verification: sandbox", "receipt-verification: blocked"));
    expect(codes(dir)).toContain("doc_overclaims");
  });

  it("fails when .env.example grows a third key", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, ".env.example"), readFileSync(join(dir, ".env.example"), "utf8") + "APPROVAL_KEY=x\n");
    expect(codes(dir)).toContain("env_example_extra");
  });

  it("fails when agent.yaml declares an event the API does not publish", () => {
    const dir = copyAgent();
    const manifest = join(dir, "agent.yaml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace("commerce.payment.succeeded", "commerce.payment.settled"));
    const report = checkAgent(dir);
    expect(report.findings.filter((f) => f.code === "events_unknown").map((f) => f.message)).toEqual([expect.stringContaining("commerce.payment.settled")]);
  });

  it("fails when eval.yaml does not extend the manifest or redeclares a field", () => {
    const dir = copyAgent();
    writeFileSync(join(dir, "evals", "eval.yaml"), "extends: ../agent.yaml\nname: other\n");
    expect(codes(dir)).toContain("eval_redeclares_manifest");
    writeFileSync(join(dir, "evals", "eval.yaml"), "cases: []\n");
    expect(codes(dir)).toContain("eval_extends");
  });

  it("fails when the batch capability is declared without the payment tool that runs it", () => {
    const dir = copyAgent();
    const t = JSON.parse(readFileSync(join(dir, "tools.json"), "utf8")) as { meta_tools: Array<{ effect: string }> };
    t.meta_tools = t.meta_tools.filter((x) => x.effect !== "payment");
    writeFileSync(join(dir, "tools.json"), JSON.stringify(t));
    // `batch-payout` rides on `pix-out`, so dropping the payment tool is what the gate catches.
    expect(codes(dir)).toContain("tools_contradict_manifest");
  });
});
