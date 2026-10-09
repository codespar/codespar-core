/**
 * The false green of OPEN_QUESTIONS §63: on staging (2026-09-27) the issuer
 * ended the bolepix in ERROR, with no QR and no boleto line, and the run still
 * answered `settled` with a cycle time, because the sandbox payer paid what
 * nobody could have paid and the API's test route settled it (ent#1816). The
 * stub scripts both halves here: an issuer that ends in ERROR, and a charge
 * that is settled without ever becoming payable.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScenario, loadScenario, runScenario } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const runsDir = mkdtempSync(join(tmpdir(), "checkout-payable-"));
/** The buyer the happy path issues to. */
const BUYER = "27548613008";

function events(bundleDir: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(bundleDir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
}

describe("a cycle closes on a payable instrument, or it does not close", () => {
  const scenario = loadScenario(agent, "happy-path");

  it("an issuer that ends the registration in ERROR fails the order with the issuer's code: never settled, never paid, no cycle to boast of", async () => {
    const run = await runScenario(agent, scenario, { mode: "human", runsDir, stubRail: { issuerErrorPayees: [BUYER] } });
    expect(run.executions.map((e) => [e.state, e.reason])).toEqual([["failed", "charge_issuer_error"]]);
    expect(run.settled_total).toBe(0);
    expect(run.receipts).toBe(0);
    expect(run.payer_calls).toEqual([]);
    expect(run.executions[0]!.payable_seen).toBeNull();
    const told = events(run.bundle_dir).filter((e) => e.type === "message.debtor").map((e) => String(e.payload["text"]));
    expect(told).toEqual([expect.stringContaining("charge_issuer_error")]);
    expect(told[0]).not.toMatch(/Recebemos/);
    // The NFS-e follows a paid order, so an order the issuer failed opens none.
    expect(events(run.bundle_dir).filter((e) => e.type.startsWith("invoice."))).toEqual([]);
    expect(checkScenario(scenario, run).ok).toBe(false);
  });

  it("a charge settled with no payable instrument seen first is refused by the gate as no_payable_instrument, and no cycle is reported", async () => {
    const run = await runScenario(agent, scenario, { mode: "human", runsDir, stubRail: { settlesUnpayablePayees: [BUYER] } });
    expect(run.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(run.executions[0]!.payable_seen).toBe(false);
    expect(run.cycle_seconds).toBeNull();
    const check = checkScenario(scenario, run);
    expect(check.ok).toBe(false);
    expect(check.failures).toEqual([expect.stringMatching(/^no_payable_instrument: /)]);
  });

  it("the ordinary happy path saw its QR before the payment, and reports its cycle", async () => {
    const run = await runScenario(agent, scenario, { mode: "human", runsDir });
    expect(run.executions[0]!.payable_seen).toBe(true);
    expect(run.cycle_seconds).toEqual(expect.any(Number));
    expect(checkScenario(scenario, run).failures).toEqual([]);
  });
});
