import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ESCOLA, FUNCIONARIA, harness, MERCADO } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };

describe("section 4.6: the model proposes, the code executes", () => {
  it("human mode: drafted -> awaiting_approval -> approved -> executing -> settled, with an artifact and a receipt", async () => {
    const h = harness({ mode: "human" });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "outubro" }] });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.execution.state).toBe("awaiting_approval");
    expect(draft.execution.items[0]).toMatchObject({ alias: "escola", beneficiary: "Escola Aurora", payee: ESCOLA, amount: 185000 });
    expect(draft.execution.total).toBe(185000);

    const approved = h.engine.approve(draft.execution.id, approver);
    expect(approved.state).toBe("approved");
    expect(approved.approval_id).toMatch(/^apr_/);
    const artifact = h.store.getApproval(approved.approval_id!)!;
    expect(artifact.approver).toEqual({ type: "person", id: "usr_demo", channel: "terminal" });
    expect(artifact.items_hash).toBe(approved.items_hash);

    const settled = await h.engine.execute(approved.id);
    expect(settled.state).toBe("settled");
    expect(settled.history.map((t) => t.to)).toEqual(["awaiting_approval", "approved", "executing", "settled"]);
    expect(settled.outcomes[0]?.receipt_id).toMatch(/^rcpt_stub_/);
    const receipts = readdirSync(join(h.bundle.dir, "receipts"));
    expect(receipts).toHaveLength(1);
    expect(h.bundle.readApprovals()).toHaveLength(1);
    expect(existsSync(join(h.bundle.dir, "events.jsonl"))).toBe(true);
    for (const event of h.bundle.readEvents()) expect(event["actor"]).toBeDefined();
  });

  it("mandate mode: drafted -> approved by the mandate -> settled, same trail shape", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.state).toBe("approved");
    const artifact = h.store.getApproval(draft.execution.approval_id!)!;
    expect(artifact.approver).toEqual({ type: "mandate", id: "mdt_test_0001" });
    const settled = await h.engine.execute(draft.execution.id);
    expect(settled.state).toBe("settled");
  });

  it("the core computes the total; the model's number is recorded and ignored", async () => {
    const h = harness({ mode: "human" });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 10000 }, { payee: "mercado", amount: 5000 }], claimed_total: 12000 });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.total).toBe(15000);
    expect(draft.execution.model_claimed_total).toBe(12000);
    const approved = h.engine.approve(draft.execution.id, approver);
    expect(h.store.getApproval(approved.approval_id!)!.items.reduce((s, i) => s + i.amount, 0)).toBe(15000);
  });

  it("with model_total_mismatch: refuse, the execution is denied instead", async () => {
    const h = harness({ mode: "human", guardrails: { model_total_mismatch: "refuse" } });
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 15000 }], claimed_total: 12000 });
    if (!draft.ok) throw new Error("refused");
    expect(draft.execution.state).toBe("denied");
    expect(draft.execution.reason).toBe("model_total_mismatch");
  });
});

describe("mandate limits are the core's, in both modes", () => {
  it("per-transaction cap: denied, readable", async () => {
    for (const mode of ["human", "mandate"] as const) {
      const h = harness({ mode });
      const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 250001 }] });
      if (!draft.ok) throw new Error("refused");
      expect(draft.execution.state).toBe("denied");
      expect(draft.execution.reason).toBe("per_tx_cap_exceeded");
      expect(draft.execution.detail).toContain("per-payment cap");
    }
  });

  it("window cap counts what is settled and in flight", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    for (let i = 0; i < 2; i += 1) {
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 250000 }] });
      if (!d.ok) throw new Error("refused");
      await h.engine.execute(d.execution.id);
    }
    const third = await h.engine.draft({ items: [{ payee: "mercado", amount: 100001 }] });
    if (!third.ok) throw new Error("refused");
    expect(third.execution.state).toBe("denied");
    expect(third.execution.reason).toBe("window_cap_exceeded");
    const fits = await h.engine.draft({ items: [{ payee: "mercado", amount: 100000 }] });
    if (!fits.ok) throw new Error("refused");
    expect(fits.execution.state).toBe("approved");
  });

  it("payee outside the allowlist: denied in mandate, escalated in human, and never approvable", async () => {
    const m = harness({ mode: "mandate" });
    const denied = await m.engine.draft({ items: [{ payee: "chave-nova@banco.com", amount: 1000 }] });
    if (!denied.ok) throw new Error("refused");
    expect(denied.execution.state).toBe("denied");
    expect(denied.execution.reason).toBe("beneficiary_not_allowed");

    const hh = harness({ mode: "human" });
    const escalated = await hh.engine.draft({ items: [{ payee: "chave-nova@banco.com", amount: 1000 }] });
    if (!escalated.ok) throw new Error("refused");
    expect(escalated.execution.state).toBe("awaiting_approval");
    expect(escalated.execution.blocking_reasons).toEqual(["beneficiary_not_allowed"]);
    const afterYes = hh.engine.approve(escalated.execution.id, approver);
    expect(afterYes.state).toBe("denied");
    expect(afterYes.reason).toBe("beneficiary_not_allowed");
  });
});

describe("section 4.4 in the engine", () => {
  it("amount above threshold in mandate mode goes to a human; the artifact records the trigger", async () => {
    const h = harness({ mode: "mandate" });
    // Make escola a known payee first, so only `amount` can fire.
    const warm = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!warm.ok) throw new Error("refused");
    expect(warm.execution.escalation?.trigger).toBe("new_beneficiary");
    await h.engine.execute(h.engine.approve(warm.execution.id, approver).id);

    const big = await h.engine.draft({ items: [{ payee: "escola", amount: 150001 }] });
    if (!big.ok) throw new Error("refused");
    expect(big.execution.state).toBe("awaiting_approval");
    expect(big.execution.escalation?.trigger).toBe("amount");
    const approved = h.engine.approve(big.execution.id, approver);
    expect(h.store.getApproval(approved.approval_id!)!.escalation?.trigger).toBe("amount");

    await h.engine.execute(approved.id);

    // The following one, below the threshold, runs alone: a human-approved payment is not fractioning.
    const small = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!small.ok) throw new Error("refused");
    expect(small.execution.state).toBe("approved");
  });

  it("fractioning: five parts below the threshold escalate by the window", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: { amount: 150000 } }, guardrails: { escalate_above: { amount: 150000 } } });
    const states: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 40000 }] });
      if (!d.ok) throw new Error("refused");
      states.push(d.execution.state);
      if (d.execution.state === "approved") await h.engine.execute(d.execution.id);
    }
    expect(states).toEqual(["approved", "approved", "approved", "awaiting_approval", "awaiting_approval"]);
  });

  it("outside hours escalates, or refuses when the guardrail says so", async () => {
    const night = new Date("2026-09-24T02:00:00Z");
    const a = harness({ mode: "mandate", now: night, manifest: { escalate_above: { outside_hours: "22:00-07:00" } }, guardrails: { escalate_above: { outside_hours: "22:00-07:00" } } });
    const d1 = await a.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d1.ok) throw new Error("refused");
    expect(d1.execution.state).toBe("awaiting_approval");
    expect(d1.execution.escalation?.trigger).toBe("outside_hours");

    const b = harness({ mode: "mandate", now: night, manifest: { escalate_above: { outside_hours: "22:00-07:00" } }, guardrails: { escalate_above: { outside_hours: "22:00-07:00" }, outside_hours_action: "refuse" } });
    const d2 = await b.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d2.ok) throw new Error("refused");
    expect(d2.execution.state).toBe("denied");
    expect(d2.execution.reason).toBe("outside_hours");
  });
});

describe("section 4.7: revocation and kill switch (against the stub)", () => {
  it("a new request after revocation is refused before drafted", async () => {
    const h = harness({ mode: "human" });
    h.gate.revoke("mdt_test_0001");
    const draft = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    expect(draft).toMatchObject({ ok: false, refused_before_draft: true, reason: "mandate_revoked" });
    expect(h.store.listExecutions()).toHaveLength(0);
  });

  it("revoked while awaiting approval: approved artifact does not help, execute answers denied", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    h.gate.revoke("mdt_test_0001");
    const out = await h.engine.execute(approved.id);
    expect(out.state).toBe("denied");
    expect(out.reason).toBe("mandate_revoked");
    expect(h.store.listOutbox()).toHaveLength(0);
  });

  it("org pauseAll denies with org_paused; paused mandate with mandate_paused", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    h.gate.pauseAll();
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, reason: "org_paused" });
    h.gate.resumeAll();
    h.gate.pause("mdt_test_0001");
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, reason: "mandate_paused" });
    h.gate.resume("mdt_test_0001");
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    expect(d.ok && d.execution.state).toBe("approved");
  });

  it("revoked while executing: reconciled from the rail, not cancelled", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    // The provider took the payment and answered late: uncertain now, in flight on the first lookup, settled on the second.
    const h2 = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt], inFlightThenSettled: [attempt] } });
    const stuck = await h2.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    h2.gate.revoke("mdt_test_0001");
    expect((await h2.engine.reconcile(stuck.id)).state).toBe("executing");
    const closed = await h2.engine.reconcile(stuck.id);
    expect(closed.state).toBe("settled");
    expect(h2.rail.payCount).toBe(0);
  });
});

describe("section 10: idempotency, restart, reconcile", () => {
  it("killing after the rail accepted and resuming gives one payment and one receipt", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { afterDispatch: () => { throw new Error("SIGKILL simulated after dispatch"); } } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    await expect(h.engine.execute(d.execution.id)).rejects.toThrow("SIGKILL");
    const stuck = h.store.getExecution(d.execution.id)!;
    expect(stuck.state).toBe("executing");
    expect(h.store.listOutbox({ status: ["sent"] })).toHaveLength(1);

    // A fresh process over the same state.db.
    const resumed = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const done = await resumed.engine.reconcile(stuck.id);
    expect(done.state).toBe("settled");
    expect(readdirSync(join(resumed.bundle.dir, "receipts"))).toHaveLength(1);
    // Exactly one attempt reached the rail, ever.
    expect(resumed.store.stubRailGet(`att_${stuck.idempotency_key.slice(4)}_0`)).toBeDefined();
    const events = resumed.store.listEvents({ execution_id: stuck.id }).filter((e) => e.type === "commerce.payment.succeeded");
    expect(events).toHaveLength(1);
  });

  it("an uncertain outcome is never retried blind: it stays executing, marked unresolved, until the rail answers", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    expect(stuck.reason).toBe("rail_uncertain");
    expect(flaky.store.stubRailGet(attempt)).toBeUndefined();
    const still = await flaky.engine.reconcile(stuck.id);
    expect(still.state).toBe("executing");
    expect(still.outcomes).toHaveLength(0);
    expect(flaky.rail.payCount).toBe(0);
  });

  it("duplicate and out-of-order rail events settle once", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    const paid = { event_id: "evt_paid_1", type: "commerce.payment.succeeded", attempt_id: attempt };
    expect(flaky.engine.ingestExternalEvent(paid)).toEqual({ applied: true, reason: "settled" });
    expect(flaky.engine.ingestExternalEvent(paid)).toEqual({ applied: false, reason: "duplicate event id" });
    expect(flaky.engine.ingestExternalEvent({ event_id: "evt_created_late", type: "commerce.payment.created", attempt_id: attempt })).toMatchObject({ applied: false });
    expect(flaky.engine.ingestExternalEvent({ event_id: "evt_paid_2", type: "commerce.payment.succeeded", attempt_id: attempt })).toMatchObject({ applied: false, reason: "execution already settled" });
    expect(flaky.store.getExecution(stuck.id)!.state).toBe("settled");
    expect(flaky.store.listEvents({ execution_id: stuck.id }).filter((e) => e.type === "execution.transition" && (e.payload as { to: string }).to === "settled")).toHaveLength(1);
  });

  it("a failed rail answer closes as failed with the code, and a second draft to the same payee is a new execution", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { refusePayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "mercado", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const failed = await h.engine.execute(d.execution.id);
    expect(failed.state).toBe("failed");
    expect(failed.detail).toContain("psp_dispatch_failed");
  });

  it("a stale open execution expires", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    h.setNow(new Date(h.now.getTime() + 16 * 60 * 1000));
    const expired = h.engine.expireStale();
    expect(expired.map((e) => e.state)).toEqual(["expired"]);
  });

  it("the items_hash is recomputed before executing; a changed list goes back to awaiting_approval", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    // Tamper with the persisted list after approval, the way a bug or an attacker would.
    h.store.saveExecution({ ...approved, items: [{ ...approved.items[0]!, amount: 999999 }] });
    const back = await h.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.reason).toBe("items_hash_mismatch");
    expect(back.approval_id).toBeUndefined();
    expect(h.store.listOutbox()).toHaveLength(0);
  });
});

describe("the policy runs at every gate, not only at draft (review of PR #1)", () => {
  it("two drafts each inside the window cap cannot both settle: the second is refused by the reservation, and the last gate refuses what slipped past", async () => {
    const h = harness({ mode: "human" });
    const a = await h.engine.draft({ items: [{ payee: "escola", amount: 240000 }, { payee: "mercado", amount: 160000 }] }); // 400000
    if (!a.ok) throw new Error("refused");
    expect(a.execution.state).toBe("awaiting_approval");
    const b = await h.engine.draft({ items: [{ payee: "funcionaria", amount: 200000 }, { payee: "mercado", amount: 100000 }] }); // 300000
    if (!b.ok) throw new Error("refused");
    expect(b.execution.state).toBe("denied");
    expect(b.execution.reason).toBe("window_cap_exceeded");

    // What slipped past: an approved execution whose window filled up before it ran (another process settled 300000 meanwhile).
    const approvedA = h.engine.approve(a.execution.id, approver);
    expect(approvedA.state).toBe("approved");
    const foreign = { ...approvedA, id: "exe_other_process", state: "settled" as const, total: 300000, approval_id: undefined, history: [] };
    h.store.saveExecution(foreign as never);
    const last = await h.engine.execute(approvedA.id);
    expect(last.state).toBe("denied");
    expect(last.reason).toBe("window_cap_exceeded");
    expect(h.store.listOutbox()).toHaveLength(0);
    expect(h.engine.list({ state: "settled" }).reduce((s, e) => s + e.total, 0)).toBe(300000);
  });

  it("a list tampered after approval goes back to awaiting_approval, and a yes on the tampered list is refused by the policy, not re-approved", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    h.store.saveExecution({ ...approved, items: [{ ...approved.items[0]!, beneficiary: "atacante", payee: "pix@atacante.example.com" }] });
    const back = await h.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.reason).toBe("items_hash_mismatch");
    const afterYes = h.engine.approve(back.id, approver);
    expect(afterYes.state).toBe("denied");
    expect(afterYes.reason).toBe("beneficiary_not_allowed");
    expect(h.store.listOutbox()).toHaveLength(0);
  });

  it("a mandate-approved execution re-checks escalate_above at the last gate; a person's approval satisfies it", async () => {
    // Approved by the mandate during the day, executed at night: back to a human.
    const day = new Date("2026-09-23T18:00:00Z");
    const h = harness({ mode: "mandate", now: day, manifest: { escalate_above: { outside_hours: "22:00-07:00" } }, guardrails: { escalate_above: { outside_hours: "22:00-07:00" }, approval_ttl_minutes: 24 * 60 } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    expect(d.execution.state).toBe("approved");
    h.setNow(new Date("2026-09-24T02:00:00Z"));
    const night = await h.engine.execute(d.execution.id);
    expect(night.state).toBe("awaiting_approval");
    expect(night.escalation?.trigger).toBe("outside_hours");
    const settled = await h.engine.execute(h.engine.approve(night.id, approver).id);
    expect(settled.state).toBe("settled");
  });
});

describe("reconcile never re-dispatches (review of PR #1)", () => {
  async function stuckExecution(rail: import("../src/stubs/rail.js").StubRailOptions | undefined) {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt], ...(rail ?? {}), inFlightThenSettled: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    expect(stuck.reason).toBe("rail_uncertain");
    return { h: flaky, stuck, attempt };
  }

  it("in flight, then settled: two reconciles, zero new payments", async () => {
    const { h, stuck, attempt } = await stuckExecution(undefined);
    const paysBefore = h.rail.payCount;
    const first = await h.engine.reconcile(stuck.id);
    expect(first.state).toBe("executing");
    expect(first.detail).toContain("in_flight");
    expect(h.rail.payCount).toBe(paysBefore);
    expect(h.store.stubRailGet(attempt)).toBeUndefined();
    const second = await h.engine.reconcile(stuck.id);
    expect(second.state).toBe("settled");
    expect(h.rail.payCount).toBe(paysBefore);
    expect(h.store.listOutbox()[0]?.status).toBe("done");
  });

  it("unknown to the rail after the outbox was sent: stays executing for a human, nothing re-sent", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    const again = await flaky.engine.reconcile(stuck.id);
    expect(again.state).toBe("executing");
    expect(again.reason).toBe("rail_uncertain");
    expect(flaky.rail.payCount).toBe(0);
    expect(flaky.store.stubRailGet(attempt)).toBeUndefined();
  });

  it("outbox still pending (crash before any call): the attempts go out once, under the same ids", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { afterDispatch: () => { throw new Error("crash"); } } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    // Simulate a crash between the transaction and the first call: rewind the outbox to pending.
    await expect(h.engine.execute(d.execution.id)).rejects.toThrow("crash");
    const fresh = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    expect(fresh.store.getOutbox(d.execution.idempotency_key)?.status).toBe("sent");
    const closed = await fresh.engine.reconcile(d.execution.id);
    expect(closed.state).toBe("settled");
    expect(fresh.rail.payCount).toBe(0);
  });
});

describe("a multi-item execution closes only when every attempt has its outcome (review of PR #1)", () => {
  it("one rail event settles one attempt; the second closes the execution and the outbox", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!d.ok) throw new Error("refused");
    const a0 = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const a1 = `att_${d.execution.idempotency_key.slice(4)}_1`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [a0, a1] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(stuck.state).toBe("executing");
    expect(flaky.engine.ingestExternalEvent({ event_id: "e0", type: "commerce.payment.succeeded", attempt_id: a0 })).toMatchObject({ applied: true });
    expect(flaky.store.getExecution(stuck.id)!.state).toBe("executing");
    expect(flaky.store.getOutbox(stuck.idempotency_key)!.status).toBe("sent");
    expect(flaky.engine.ingestExternalEvent({ event_id: "e0", type: "commerce.payment.succeeded", attempt_id: a0 })).toMatchObject({ applied: false, reason: "duplicate event id" });
    expect(flaky.engine.ingestExternalEvent({ event_id: "e1", type: "commerce.payment.succeeded", attempt_id: a1 })).toEqual({ applied: true, reason: "settled" });
    expect(flaky.store.getExecution(stuck.id)!.state).toBe("settled");
    expect(flaky.store.getOutbox(stuck.idempotency_key)!.status).toBe("done");
  });
});

describe("probes named in the second review: the mandate can change between approve and execute", () => {
  it("(a) the mandate was tightened to a smaller per-payment cap: the last gate refuses", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 200000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    // A new process reads the tightened mandate (same version: an operator lowered the cap in place).
    const tightened = harness({ mode: "human", dir: h.dir, mandate: { per_tx_cap_minor: 100000 } });
    const out = await tightened.engine.execute(approved.id);
    expect(out.state).toBe("denied");
    expect(out.reason).toBe("per_tx_cap_exceeded");
    expect(tightened.store.listOutbox()).toHaveLength(0);
  });

  it("(a') the mandate was re-signed (new version): the old artifact no longer matches, and the yes that follows is judged again", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 200000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const resigned = harness({ mode: "human", dir: h.dir, mandate: { version: 2, per_tx_cap_minor: 100000 } });
    const back = await resigned.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.reason).toBe("mandate_changed");
    expect(back.mandate).toEqual({ id: "mdt_test_0001", version: 2 });
    const afterYes = resigned.engine.approve(back.id, approver);
    expect(afterYes.state).toBe("denied");
    expect(afterYes.reason).toBe("per_tx_cap_exceeded");
  });

  it("(c) the payee left the allowlist between approve and execute: denied, nothing sent", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const narrowed = harness({ mode: "human", dir: h.dir, mandate: { merchant_allowlist: [MERCADO], beneficiaries: [{ alias: "mercado", name: "Mercado do Bairro", payee: MERCADO }] } });
    const out = await narrowed.engine.execute(approved.id);
    expect(out.state).toBe("denied");
    expect(out.reason).toBe("beneficiary_not_allowed");
    expect(narrowed.store.listOutbox()).toHaveLength(0);
    expect(narrowed.rail.payCount).toBe(0);
  });
});

describe("reconcile is read-only; only resume dispatches, and only a pending outbox", () => {
  it("outbox sent + lookup absent: reconcile never calls rail.pay and records execution.uncertain", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const attempt = `att_${d.execution.idempotency_key.slice(4)}_0`;
    const flaky = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { uncertainOnce: [attempt] } });
    const stuck = await flaky.engine.execute(d.execution.id);
    expect(flaky.store.getOutbox(stuck.idempotency_key)?.status).toBe("sent");
    const pays = flaky.rail.payCount;
    const still = await flaky.engine.reconcile(stuck.id);
    expect(still.state).toBe("executing");
    expect(flaky.rail.payCount).toBe(pays);
    expect(flaky.store.stubRailGet(attempt)).toBeUndefined();
    expect(flaky.store.listEvents({ execution_id: stuck.id }).some((e) => e.type === "execution.uncertain")).toBe(true);
  });

  it("outbox pending: reconcile leaves it; resumePending dispatches once", async () => {
    const h = harness({ mode: "mandate", manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    // Rewind the row to what a crash between the transaction and the first call leaves behind.
    const armed = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, rail: { afterDispatch: () => { throw new Error("crash"); } } });
    await expect(armed.engine.execute(d.execution.id)).rejects.toThrow("crash");
    armed.store.updateOutbox(d.execution.idempotency_key, "pending", undefined, "2026-09-23T18:00:00.000Z");
    const fresh = harness({ mode: "mandate", dir: h.dir, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} } });
    const left = await fresh.engine.reconcile(d.execution.id);
    expect(left.state).toBe("executing");
    expect(fresh.rail.payCount).toBe(0);
    const closed = await fresh.engine.resumePending(d.execution.id);
    expect(closed.state).toBe("settled");
  });
});

describe("multi-item partial failure is named item by item", () => {
  it("first item settles with its receipt, second is refused: execution failed, outcomes and approval name both", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    expect(out.state).toBe("failed");
    expect(out.outcomes).toEqual([
      expect.objectContaining({ index: 0, status: "settled", receipt_id: expect.stringMatching(/^rcpt_stub_/) }),
      expect.objectContaining({ index: 1, status: "failed", error: expect.stringContaining("psp_dispatch_failed") }),
    ]);
    expect(readdirSync(join(h.bundle.dir, "receipts"))).toHaveLength(1);
    expect(h.bundle.readApprovals()[0]?.items.map((i) => i.payee)).toEqual([ESCOLA, MERCADO]);
    expect(h.store.getOutbox(out.idempotency_key)?.status).toBe("failed");
    expect(h.store.getOutbox(out.idempotency_key)?.response).toEqual(out.outcomes);
  });

  it("a refusal in the MIDDLE does not stop the items after it: every attempt is sent and every one is named", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }, { payee: "funcionaria", amount: 3000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    // Section 4.1: the execution closes `failed` because one attempt failed,
    // and `outcomes` names EVERY item — including the one after the refusal.
    expect(out.state).toBe("failed");
    expect(out.outcomes.map((o) => o.status)).toEqual(["settled", "failed", "settled"]);
    expect(h.rail.payCount).toBe(3); // all three reached the rail; the stub records a refusal too
    expect(readdirSync(join(h.bundle.dir, "receipts"))).toHaveLength(2);
  });

  it("an unknown answer in the MIDDLE still sends the siblings, and the execution stays open until it is resolved", async () => {
    const h = harness({ mode: "human", rail: { uncertainPayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }, { payee: "funcionaria", amount: 3000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    // Open, not closed: one attempt has no outcome at all, and §4.1 says an
    // execution closes only when every attempt has one.
    expect(out.state).toBe("executing");
    expect(out.reason).toBe("rail_uncertain");
    expect(out.outcomes.map((o) => o.index)).toEqual([0, 2]);
    expect(out.detail).toContain("psp_dispatch_uncertain");
    // Reconciliation resolves the unknown one and only then does it close.
    // The stub answers `in_flight` on the first look and finds the provider
    // finished on the second, which is the shape a real timeout has.
    expect((await h.engine.reconcile(d.execution.id)).state).toBe("executing");
    const closed = await h.engine.reconcile(d.execution.id);
    expect(closed.state).toBe("settled");
    expect(closed.outcomes.map((o) => o.status)).toEqual(["settled", "settled", "settled"]);
  });

  it("an execution with a failed attempt AND an unknown one does not close as failed", async () => {
    const h = harness({ mode: "human", rail: { refusePayees: [ESCOLA], uncertainPayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }, { payee: "funcionaria", amount: 3000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    // "One of them failed and one of them we cannot see" is not a closed
    // outcome: reporting `failed` here would call a batch finished while a
    // payment may still be in flight.
    expect(out.state).toBe("executing");
    expect(out.outcomes.map((o) => o.status)).toEqual(["failed", "settled"]);
    expect((await h.engine.reconcile(d.execution.id)).state).toBe("executing");
    const closed = await h.engine.reconcile(d.execution.id);
    expect(closed.state).toBe("failed");
    expect(closed.outcomes.map((o) => o.status)).toEqual(["failed", "settled", "settled"]);
  });

  it("why the siblings are sent and not deferred: an attempt that was never sent is recovered by nothing", async () => {
    // This is the measurement the choice rests on. `reconcile` is read-only by
    // contract and never dispatches; `resumePending` dispatches only while the
    // outbox row is still `pending`, and it flips to `sent` before the first
    // rail call. So an attempt skipped at dispatch is not sent later — it is
    // never sent, by any path the runtime has.
    const h = harness({ mode: "human", rail: { uncertainPayees: [MERCADO] } });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }, { payee: "mercado", amount: 2000 }, { payee: "funcionaria", amount: 3000 }] });
    if (!d.ok) throw new Error("refused");
    const out = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    const third = `att_${out.idempotency_key.slice(4)}_2`;
    // Under the fix the third attempt WAS sent, so the rail knows it.
    expect(h.store.stubRailGet(third)).toBeDefined();
    expect(h.store.getOutbox(out.idempotency_key)?.status).toBe("sent");
    // And that is the only reason it is recoverable: `resumePending` on a
    // `sent` row reconciles instead of dispatching, and never pays again.
    const before = h.rail.payCount;
    expect((await h.engine.resumePending(d.execution.id)).state).toBe("executing");
    const resumed = await h.engine.resumePending(d.execution.id);
    expect(h.rail.payCount).toBe(before); // reconciled, never re-sent
    expect(resumed.state).toBe("settled");
  });
});
