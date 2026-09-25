/**
 * The webhook channel closes the cycle from a trigger delivery: signature
 * verified when a secret is set, duplicates dropped, out-of-order ignored,
 * the payer told once, the paid record fetched.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { announceOutcome, createWebhookHandler, setup, verifySignature } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

function issued(mode: "human" | "mandate" = "mandate") {
  let clock = new Date("2026-09-23T18:00:00Z");
  const s = setup(agent, { mode, rail: "stub", provider: "replay", transcript: "unused", stateDir: mkdtempSync(join(tmpdir(), "collections-webhook-")), runsDir: mkdtempSync(join(tmpdir(), "collections-webhook-runs-")), now: () => (clock = new Date(clock.getTime() + 1000)), say: () => undefined });
  s.payer!.behave("never");
  return s;
}

function delivery(id: string, type: string, chargeId: string): string {
  return JSON.stringify({ id, type, source: "celcoin", occurred_at: "2026-09-23T18:00:30.000Z", data: { payment_id: chargeId, amount_minor: 108000, currency: "BRL", simulated: true, settled_against: "sandbox_fixture" } });
}

function sign(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex")}`;
}

describe("channels/webhook", () => {
  it("paid twice, created late, expired after paid: one settled, one message, one record", async () => {
    const s = issued();
    try {
      const d = await s.engine.draft({ items: [{ payee: "acordo-1042", amount: 108000, due_date: "2026-09-30" }] });
      if (!d.ok) throw new Error("refused");
      const e = await s.engine.execute(d.execution.id);
      expect(e.state).toBe("executing");
      const chargeId = e.outcomes[0]!.transaction_id!;
      const told: string[] = [];
      const handle = createWebhookHandler({ engine: s.engine, onClosed: (x) => void announceOutcome(x, s, (l) => told.push(l)) });
      expect(await handle({}, delivery("evt_1", "commerce.charge.paid", chargeId))).toEqual({ status: 200, body: { applied: true, reason: "settled" } });
      expect(await handle({}, delivery("evt_1", "commerce.charge.paid", chargeId))).toEqual({ status: 200, body: { applied: false, reason: "duplicate event id" } });
      expect(await handle({}, delivery("evt_2", "commerce.charge.created", chargeId))).toMatchObject({ status: 200, body: { applied: false } });
      expect(await handle({}, delivery("evt_3", "commerce.charge.expired", chargeId))).toMatchObject({ status: 200, body: { applied: false, reason: "execution already settled" } });
      expect(await handle({}, delivery("evt_4", "commerce.charge.paid", "chg_not_ours"))).toMatchObject({ status: 200, body: { applied: false, reason: "unknown attempt" } });
      expect(await handle({}, "{not json")).toMatchObject({ status: 400 });
      expect(s.engine.get(e.id)!.state).toBe("settled");
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("acordo quitado");
      expect(s.bundle.listReceipts()).toEqual([`${chargeId}.json`]);
      expect(s.store.listEvents({ run_id: s.runId }).filter((ev) => ev.type === "message.debtor")).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it("with a trigger secret: a missing, stale or wrong signature is 401 and moves nothing", async () => {
    const s = issued();
    try {
      const d = await s.engine.draft({ items: [{ payee: "acordo-1042", amount: 108000, due_date: "2026-09-30" }] });
      if (!d.ok) throw new Error("refused");
      const e = await s.engine.execute(d.execution.id);
      const chargeId = e.outcomes[0]!.transaction_id!;
      const now = new Date("2026-09-23T18:01:00Z");
      const handle = createWebhookHandler({ engine: s.engine, secret: "whsec_test", clock: () => now });
      const body = delivery("evt_s1", "commerce.charge.paid", chargeId);
      expect((await handle({}, body)).status).toBe(401);
      expect((await handle({ "x-codespar-signature": sign("whsec_other", body, Math.floor(now.getTime() / 1000)) }, body)).status).toBe(401);
      expect((await handle({ "x-codespar-signature": sign("whsec_test", body, Math.floor(now.getTime() / 1000) - 3600) }, body)).status).toBe(401);
      expect(s.engine.get(e.id)!.state).toBe("executing");
      expect(await handle({ "x-codespar-signature": sign("whsec_test", body, Math.floor(now.getTime() / 1000)) }, body)).toEqual({ status: 200, body: { applied: true, reason: "settled" } });
      expect(verifySignature("whsec_test", "garbage", body, now, 300)).toMatchObject({ ok: false });
    } finally {
      s.close();
    }
  });

  it("expired by webhook closes failed with charge_expired and tells the payer once", async () => {
    const s = issued("human");
    try {
      const d = await s.engine.draft({ items: [{ payee: "acordo-1103", amount: 40500, due_date: "2026-09-25" }] });
      if (!d.ok) throw new Error("refused");
      const approved = s.engine.approve(d.execution.id, { id: "usr_operator", channel: "terminal" });
      const e = await s.engine.execute(approved.id);
      const chargeId = e.outcomes[0]!.transaction_id!;
      const told: string[] = [];
      const handle = createWebhookHandler({ engine: s.engine, onClosed: (x) => void announceOutcome(x, s, (l) => told.push(l)) });
      expect(await handle({}, delivery("evt_x1", "commerce.charge.expired", chargeId))).toEqual({ status: 200, body: { applied: true, reason: "failed" } });
      expect(await handle({}, delivery("evt_x2", "commerce.charge.paid", chargeId))).toMatchObject({ body: { applied: false } });
      expect(s.engine.get(e.id)).toMatchObject({ state: "failed", reason: "charge_expired" });
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("venceu");
      expect(s.bundle.listReceipts()).toEqual([]);
    } finally {
      s.close();
    }
  });
});
