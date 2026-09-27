/**
 * Section 11: what the proof bundle has to carry for `npm run inspect` to
 * answer "why could the agent pay this" from the folder alone — the rail's
 * request and its answer per attempt, and a receipt path that travels with
 * the bundle instead of naming the machine that wrote it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maskPayee } from "../src/bundle.js";
import { harness } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };

async function settledRun() {
  const h = harness({ mode: "human" });
  const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "outubro" }] });
  if (!draft.ok) throw new Error("refused");
  const approved = h.engine.approve(draft.execution.id, approver);
  const settled = await h.engine.execute(approved.id);
  return { h, settled };
}

describe("the proof bundle records the rail call and its answer", () => {
  it("rail.dispatch names the idempotency key that makes a retry the same payment", async () => {
    const { h, settled } = await settledRun();
    const dispatch = h.bundle.readEvents().find((e) => e["type"] === "rail.dispatch");
    expect(dispatch).toBeDefined();
    const payload = dispatch!["payload"] as Record<string, unknown>;
    expect(payload["idempotency_key"]).toBe(settled.idempotency_key);
    expect(payload["attempt_id"]).toBe(settled.outcomes[0]?.attempt_id);
    expect(payload["rail"]).toBe("stub");
  });

  it("rail.outcome carries what the rail answered: transaction, receipt and whether money moved", async () => {
    const { h, settled } = await settledRun();
    const outcome = h.bundle.readEvents().find((e) => e["type"] === "rail.outcome");
    const payload = outcome!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("settled");
    expect(payload["receipt_id"]).toBe(settled.outcomes[0]?.receipt_id);
    expect(payload["transaction_id"]).toBe(settled.outcomes[0]?.transaction_id);
    expect(payload["money_moved"]).toBe(false);
    expect(payload["sandbox"]).toBe(true);
    // Never the provider's echo: `raw` may carry payer data the bundle does not promise to mask.
    expect(payload["raw"]).toBeUndefined();
  });

  it("a refused attempt records the rail's own code and message", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: ["escola@exemplo.com.br"] } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!draft.ok) throw new Error("refused");
    const approved = h.engine.approve(draft.execution.id, approver);
    await h.engine.execute(approved.id);
    const outcome = h.bundle.readEvents().find((e) => e["type"] === "rail.outcome");
    const payload = outcome!["payload"] as Record<string, unknown>;
    expect(payload["status"]).toBe("failed");
    expect(payload["code"]).toBeTypeOf("string");
    expect(payload["message"]).toBeTypeOf("string");
  });

  it("receipt.saved names the file inside the bundle, not the machine that wrote it", async () => {
    const { h } = await settledRun();
    const saved = h.bundle.readEvents().find((e) => e["type"] === "receipt.saved");
    const path = (saved!["payload"] as { path: string }).path;
    expect(path).toMatch(/^receipts\//);
    expect(path).not.toContain(h.bundle.dir);
    const receipt = JSON.parse(readFileSync(join(h.bundle.dir, path), "utf8")) as { payment: { payee: string } };
    expect(receipt.payment.payee).toBe(maskPayee("escola@exemplo.com.br"));
  });

  it("the mandate snapshot carries the version the approval artifact names", async () => {
    const { h, settled } = await settledRun();
    h.bundle.mandateSnapshot(h.engine.mandate);
    const snapshot = JSON.parse(readFileSync(join(h.bundle.dir, "mandate.snapshot.json"), "utf8")) as { version: number; signature?: string };
    expect(snapshot.version).toBe(settled.mandate.version);
    expect(snapshot.signature).toBeUndefined();
    expect(h.bundle.readApprovals()[0]?.mandate.version).toBe(snapshot.version);
  });

  it("maskPayee is idempotent, so a reader may apply it to a value the bundle already masked", () => {
    for (const raw of ["escola@exemplo.com.br", "+5511999990001", "12345678909", "*"]) {
      expect(maskPayee(maskPayee(raw))).toBe(maskPayee(raw));
    }
  });
});
