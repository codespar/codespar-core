/**
 * The receivable side of the core (collections-agent): a charge is ISSUED,
 * not settled, when the rail accepts it; the execution stays `executing`
 * until the payer acts, and closes from a lookup (the poll) or from a
 * `commerce.charge.*` event (the webhook). Never twice, never on prose.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outcomeOf, type ChargeView } from "../src/api/charge-rail.js";
import { hmacSigner } from "../src/approval.js";
import { ProofBundle } from "../src/bundle.js";
import { ExecutionEngine, type EngineDeps, type PolicyExtension } from "../src/engine.js";
import { itemsHash } from "../src/hash.js";
import { StateStore } from "../src/state/store.js";
import { LocalMandateStatusStub } from "../src/stubs/mandate-status.js";
import { StubChargeRail, type StubChargeRailOptions } from "../src/stubs/charge-rail.js";
import { testGuardrails, testManifest, testMandate } from "./helpers.js";

const DEBTOR = "11144477735";
const OTHER = "22233344450";

function receivables(options: { mode?: "human" | "mandate"; rail?: StubChargeRailOptions; policyExtension?: PolicyExtension; dir?: string } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "agent-core-recv-"));
  let now = new Date("2026-09-23T18:00:00Z");
  const clock = () => now;
  const store = new StateStore(join(dir, "state.db"));
  const gate = new LocalMandateStatusStub(store, clock);
  const rail = new StubChargeRail(store, { clock, ...(options.rail ?? {}) });
  const bundle = new ProofBundle(join(dir, "runs"), "run_recv");
  const mode = options.mode ?? "mandate";
  const deps: EngineDeps = {
    store,
    rail,
    status: gate,
    signer: hmacSigner("test", Buffer.alloc(32, 2)),
    manifest: testManifest({ name: "collections-agent", escalate_above: {}, maturity: { "bolepix-receivables": "sandbox" } }),
    guardrails: testGuardrails({ approval: mode, escalate_above: {} }),
    mandate: testMandate({
      agent_id: "collections-agent",
      purpose: "cobranca",
      merchant_pin_kind: "document",
      merchant_allowlist: [DEBTOR, OTHER],
      beneficiaries: [{ alias: "acordo-1", name: "Joana Devedora", payee: DEBTOR }],
    }),
    bundle,
    mode,
    runId: "run_recv",
    onBehalfOf: "merchant_demo",
    clock,
    policyExtension: options.policyExtension,
  };
  const engine = new ExecutionEngine(deps);
  return { dir, store, rail, bundle, engine, setNow: (d: Date) => (now = d) };
}

describe("a receivable is accepted, then settled by the payer", () => {
  it("execute leaves the execution executing (awaiting_settlement) with the instrument; two looks later it is settled with the charge as receipt", async () => {
    const h = receivables();
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 108000, due_date: "2026-09-30", description: "acordo 1042, a vista" }] });
    if (!d.ok) throw new Error("refused");
    expect(d.execution.state).toBe("approved");
    expect(d.execution.items[0]?.due_date).toBe("2026-09-30");

    const issued = await h.engine.execute(d.execution.id);
    expect(issued.state).toBe("executing");
    expect(issued.reason).toBe("awaiting_settlement");
    expect(issued.outcomes[0]).toMatchObject({ status: "accepted", instrument: { payable: false, status: "PROCESSING" } });
    expect(h.store.getOutbox(issued.idempotency_key)!.status).toBe("sent");

    const registered = await h.engine.reconcile(issued.id);
    expect(registered.state).toBe("executing");
    expect(registered.outcomes[0]?.instrument).toMatchObject({ payable: true, status: "PENDING" });
    expect(registered.outcomes[0]?.instrument?.pix_copy_paste).toContain("br.gov.bcb.pix");

    const paid = await h.engine.reconcile(issued.id);
    expect(paid.state).toBe("settled");
    expect(paid.history.map((t) => t.to)).toEqual(["approved", "executing", "settled"]);
    expect(paid.outcomes[0]).toMatchObject({ status: "settled", receipt_id: paid.outcomes[0]!.transaction_id });
    expect(h.store.getOutbox(issued.idempotency_key)!.status).toBe("done");
    expect(h.bundle.listReceipts()).toHaveLength(1);
    const events = h.bundle.readEvents();
    expect(events.filter((e) => e["type"] === "commerce.charge.paid")).toHaveLength(1);
    expect(events.filter((e) => e["type"] === "charge.instrument").map((e) => (e["payload"] as { payable: boolean }).payable)).toEqual([false, true]);
    // A third look changes nothing and issues nothing.
    expect((await h.engine.reconcile(issued.id)).state).toBe("settled");
    expect(h.rail.issueCount).toBe(1);
  });

  it("a receivable nobody pays closes failed with charge_expired, never settled", async () => {
    const h = receivables({ rail: { payer: "expires" } });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 50000, due_date: "2026-09-25" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await h.engine.execute(d.execution.id);
    await h.engine.reconcile(issued.id);
    const closed = await h.engine.reconcile(issued.id);
    expect(closed.state).toBe("failed");
    expect(closed.reason).toBe("charge_expired");
    expect(h.bundle.listReceipts()).toHaveLength(0);
    expect(h.store.getOutbox(issued.idempotency_key)!.status).toBe("failed");
  });

  it("the poll logs an observed state once, however many times it sees it", async () => {
    const h = receivables({ rail: { payer: "never" } });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 50000, due_date: "2026-09-25" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await h.engine.execute(d.execution.id);
    for (let i = 0; i < 5; i += 1) await h.engine.reconcile(issued.id);
    const events = h.store.listEvents({ execution_id: issued.id });
    // Five looks, one observed state (PENDING, payable): one line. The instrument log names the two states the charge went through.
    expect(events.filter((e) => e.type === "rail.reconcile")).toHaveLength(1);
    expect(events.filter((e) => e.type === "charge.instrument")).toHaveLength(2);
    expect(events.filter((e) => e.type === "execution.awaiting_settlement")).toHaveLength(1);
  });

  it("killed after the issuance and resumed: one charge, one settlement", async () => {
    const h = receivables();
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 50000, due_date: "2026-09-25" }] });
    if (!d.ok) throw new Error("refused");
    let died = false;
    const flaky = receivables({ dir: h.dir, rail: { afterDispatch: () => { died = true; throw new Error("killed"); } } });
    await expect(flaky.engine.execute(d.execution.id)).rejects.toThrow("killed");
    expect(died).toBe(true);
    // The row says executing and the outbox says sent: resume reconciles, never re-issues.
    const again = receivables({ dir: h.dir });
    const stuck = again.store.getExecution(d.execution.id)!;
    expect(stuck.state).toBe("executing");
    const first = await again.engine.resumePending(stuck.id);
    expect(first.state).toBe("executing");
    expect(first.outcomes[0]?.status).toBe("accepted");
    const settled = await again.engine.reconcile(stuck.id);
    expect(settled.state).toBe("settled");
    expect(again.rail.issueCount).toBe(0);
    expect((again.store as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare("SELECT COUNT(*) AS n FROM stub_rail_attempts").get().n).toBe(1);
  });

  it("an instalment agreement is N receivables; the execution settles when every parcel is paid", async () => {
    const h = receivables();
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 40000, due_date: "2026-09-30" }, { payee: "acordo-1", amount: 40000, due_date: "2026-10-30" }, { payee: "acordo-1", amount: 40000, due_date: "2026-11-30" }] });
    if (!d.ok) throw new Error("refused");
    expect(d.execution.total).toBe(120000);
    const issued = await h.engine.execute(d.execution.id);
    expect(issued.outcomes.map((o) => o.status)).toEqual(["accepted", "accepted", "accepted"]);
    expect(h.rail.issueCount).toBe(3);
    const a2 = issued.outcomes[2]!.attempt_id;
    h.rail.decide(a2, "never");
    await h.engine.reconcile(issued.id);
    const partly = await h.engine.reconcile(issued.id);
    expect(partly.state).toBe("executing");
    expect(partly.outcomes.map((o) => o.status)).toEqual(["settled", "settled", "accepted"]);
    h.rail.decide(a2, "pays");
    const done = await h.engine.reconcile(issued.id);
    expect(done.state).toBe("settled");
    expect(h.bundle.listReceipts()).toHaveLength(3);
  });
});

describe("the webhook path: commerce.charge.* by attempt id or by the rail's charge id", () => {
  it("paid twice settles once; paid before created is fine; expired after paid moves nothing", async () => {
    const h = receivables({ rail: { payer: "never" } });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 50000, due_date: "2026-09-25" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await h.engine.execute(d.execution.id);
    const chargeId = issued.outcomes[0]!.transaction_id!;
    expect(h.engine.ingestExternalEvent({ event_id: "evt_paid_1", type: "commerce.charge.paid", transaction_id: chargeId })).toEqual({ applied: true, reason: "settled" });
    expect(h.engine.ingestExternalEvent({ event_id: "evt_paid_1", type: "commerce.charge.paid", transaction_id: chargeId })).toEqual({ applied: false, reason: "duplicate event id" });
    expect(h.engine.ingestExternalEvent({ event_id: "evt_created_late", type: "commerce.charge.created", transaction_id: chargeId })).toMatchObject({ applied: false });
    expect(h.engine.ingestExternalEvent({ event_id: "evt_paid_2", type: "commerce.charge.paid", transaction_id: chargeId })).toMatchObject({ applied: false, reason: "execution already settled" });
    expect(h.engine.ingestExternalEvent({ event_id: "evt_expired_late", type: "commerce.charge.expired", transaction_id: chargeId })).toMatchObject({ applied: false, reason: "execution already settled" });
    const settled = h.store.getExecution(issued.id)!;
    expect(settled.state).toBe("settled");
    expect(settled.outcomes[0]).toMatchObject({ status: "settled", transaction_id: chargeId, receipt_id: chargeId });
    expect(h.store.listEvents({ execution_id: issued.id }).filter((e) => e.type === "execution.transition" && (e.payload as { to: string }).to === "settled")).toHaveLength(1);
    // The settlement came by event, so the bundle holds no receipt yet; collectReceipts fetches it once.
    expect(h.bundle.listReceipts()).toHaveLength(0);
    expect(await h.engine.collectReceipts(issued.id)).toEqual([chargeId]);
    expect(await h.engine.collectReceipts(issued.id)).toEqual([]);
    expect(h.bundle.listReceipts()).toHaveLength(1);
  });

  it("expired by event closes failed with charge_expired; a later paid for the same charge moves nothing", async () => {
    const h = receivables({ rail: { payer: "never" } });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 50000, due_date: "2026-09-25" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await h.engine.execute(d.execution.id);
    const attempt = issued.outcomes[0]!.attempt_id;
    expect(h.engine.ingestExternalEvent({ event_id: "evt_exp", type: "commerce.charge.expired", attempt_id: attempt })).toEqual({ applied: true, reason: "failed" });
    expect(h.store.getExecution(issued.id)!.reason).toBe("charge_expired");
    expect(h.engine.ingestExternalEvent({ event_id: "evt_paid_after", type: "commerce.charge.paid", attempt_id: attempt })).toMatchObject({ applied: false });
  });

  it("an event naming a charge this kit never issued is not applied", () => {
    const h = receivables();
    expect(h.engine.ingestExternalEvent({ event_id: "evt_x", type: "commerce.charge.paid", transaction_id: "chg_someone_elses" })).toEqual({ applied: false, reason: "unknown attempt" });
    expect(h.engine.ingestExternalEvent({ event_id: "evt_y", type: "commerce.charge.paid" })).toMatchObject({ applied: false });
  });
});

describe("the kit's envelope runs at every gate, and only tightens", () => {
  const envelope: PolicyExtension = (execution) => {
    const principal = 120000;
    if (execution.total < principal * 0.85) return { reason: "outside_envelope", detail: `total ${execution.total} is below the floor of ${principal * 0.85} (15% off ${principal})` };
    return undefined;
  };

  it("a proposal below the discount floor is denied at draft, even in human mode", async () => {
    const h = receivables({ mode: "human", policyExtension: envelope });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 1000, due_date: "2026-09-30" }] });
    if (!d.ok) throw new Error("refused");
    expect(d.execution.state).toBe("denied");
    expect(d.execution.reason).toBe("outside_envelope");
  });

  it("a debtor without an open agreement is not a payee: denied in mandate, blocked for the human, never approvable", async () => {
    const h = receivables({ mode: "human", policyExtension: envelope });
    const d = await h.engine.draft({ items: [{ payee: "99988877766", amount: 120000, due_date: "2026-09-30" }] });
    if (!d.ok) throw new Error("refused");
    expect(d.execution.state).toBe("awaiting_approval");
    expect(d.execution.blocking_reasons).toEqual(["beneficiary_not_allowed"]);
    expect(h.engine.approve(d.execution.id, { id: "usr_operator", channel: "terminal" }).state).toBe("denied");
  });

  it("the due date is part of the items_hash: moving it after approval is another charge", () => {
    const a = itemsHash([{ beneficiary: "x", payee: DEBTOR, amount: 100, currency: "BRL", due_date: "2026-09-30" }]);
    const b = itemsHash([{ beneficiary: "x", payee: DEBTOR, amount: 100, currency: "BRL", due_date: "2026-10-30" }]);
    const c = itemsHash([{ beneficiary: "x", payee: DEBTOR, amount: 100, currency: "BRL" }]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("outcomeOf: the API's charge view, mapped by fields and never by prose", () => {
  const base: ChargeView = {
    id: "chg_1",
    status: "PENDING",
    local_status: "pending",
    status_conflict: false,
    method: "boleto",
    currency: "BRL",
    amount: 1080.5,
    amount_minor: 108050,
    due_date: "2026-09-30",
    payable: true,
    boleto_bar_code: "1".repeat(44),
    boleto_bank_line: "2".repeat(47),
    pix_copy_paste: "000201...",
    credit_correlation_armed: true,
    payment_in_flight: false,
    settlement: null,
    issuance_unconfirmed: false,
  };
  it("maps the five states", () => {
    expect(outcomeOf(base)).toMatchObject({ status: "accepted", transaction_id: "chg_1", instrument: { payable: true, status: "PENDING", pix_copy_paste: "000201..." } });
    expect(outcomeOf({ ...base, status: "PROCESSING", payable: false, pix_copy_paste: null })).toMatchObject({ status: "accepted", instrument: { payable: false } });
    expect(outcomeOf({ ...base, local_status: "settled", status: "CONFIRMED", settlement: "confirmed" })).toMatchObject({ status: "settled", transaction_id: "chg_1", receipt_id: "chg_1", money_moved: false });
    expect(outcomeOf({ ...base, local_status: "expired", status: "CANCELLED" })).toMatchObject({ status: "failed", code: "charge_expired" });
    expect(outcomeOf({ ...base, status: "EXPIRED" })).toMatchObject({ status: "failed", code: "charge_expired" });
    expect(outcomeOf({ ...base, status: "CANCELLED" })).toMatchObject({ status: "failed", code: "charge_cancelled" });
    expect(outcomeOf({ ...base, id: null, issuance_unconfirmed: true })).toEqual({ status: "in_flight" });
  });
  it("a payment notified and not yet credited is still accepted: nothing settles on a notification", () => {
    expect(outcomeOf({ ...base, payment_in_flight: true, settlement: "pending" })).toMatchObject({ status: "accepted" });
  });
});
