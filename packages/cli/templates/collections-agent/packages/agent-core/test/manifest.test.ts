import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/manifest.js";

const valid = `
schema: 1
name: bills-agent
version: 0.1.0
approval: [human, mandate]
default_approval: human
escalate_above:
  amount: 150000
  new_beneficiary: true
  outside_hours: "22:00-07:00"
mcp: "@codespar/mcp@0.5.8"
cli: "@codespar/cli@0.13.0"
tools: ./tools.json
guardrails: ./guardrails.json
mandate_schema: ./mandate.example.json
events: [commerce.payment.succeeded, commerce.payment.failed]
channels: [terminal]
maturity:
  pix-out: sandbox
  embedded-consent: sandbox
  receipt-verification: blocked
scenarios: ./scenarios/
evals: ./evals/
agents_md: ./AGENTS.md
`;

describe("section 4.3: agent.yaml schema 1", () => {
  it("parses the example", () => {
    const m = parseManifest(valid);
    expect(m.name).toBe("bills-agent");
    expect(m.escalate_above?.amount).toBe(150000);
  });

  it("refuses an unpinned mcp or cli, a wrong schema, and an unknown field", () => {
    expect(() => parseManifest(valid.replace('"@codespar/mcp@0.5.8"', '"@codespar/mcp"'))).toThrow(/mcp/);
    expect(() => parseManifest(valid.replace('"@codespar/cli@0.13.0"', '"@codespar/cli@latest"'))).toThrow(/cli/);
    expect(() => parseManifest(valid.replace("schema: 1", "schema: 2"))).toThrow();
    expect(() => parseManifest(valid + "telemetry: true\n")).toThrow(/unrecognized/i);
    expect(() => parseManifest(valid.replace("default_approval: human", "default_approval: mandate").replace("approval: [human, mandate]", "approval: [human]"))).toThrow(/default_approval/);
    expect(() => parseManifest(valid.replace('outside_hours: "22:00-07:00"', 'outside_hours: "10pm-7am"'))).toThrow(/HH:MM/);
  });
});
