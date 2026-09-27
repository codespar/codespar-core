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
import { CodeSparChargeRail, outcomeOf, type ChargeView } from "../src/api/charge-rail.js";
import { createCodeSparClient } from "../src/api/client.js";
import { hmacSigner } from "../src/approval.js";
import { ProofBundle } from "../src/bundle.js";
import { ExecutionEngine, type EngineDeps, type PolicyExtension } from "../src/engine.js";
import type { PaymentRail, RailPayment } from "../src/rail.js";
import { itemsHash } from "../src/hash.js";
import { StateStore } from "../src/state/store.js";
import { LocalMandateStatusStub } from "../src/stubs/mandate-status.js";
import { StubChargeRail, type StubChargeRailOptions } from "../src/stubs/charge-rail.js";
import { testGuardrails, testManifest, testMandate } from "./helpers.js";

const DEBTOR = "11144477735";
const OTHER = "22233344450";

function receivables(options: { mode?: "human" | "mandate"; rail?: StubChargeRailOptions; policyExtension?: PolicyExtension; dir?: string; dispatchTo?: PaymentRail } = {}) {
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
    rail: options.dispatchTo ?? rail,
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

describe("CodeSparChargeRail: what crosses the wire on a create", () => {
  it("sends consumer_id, method boleto, due_date, the attempt id as idempotency_key and the amount in major units; refuses without a consumer", async () => {
    const { CodeSparChargeRail } = await import("../src/api/charge-rail.js");
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const api = {
      post: async (path: string, opts: { body: Record<string, unknown> }) => {
        calls.push({ path, body: opts.body });
        return { id: "chg_wire_1", status: "PROCESSING", local_status: "pending", status_conflict: false, method: "boleto", currency: "BRL", amount: 1080, amount_minor: 108000, due_date: "2026-09-30", payable: false, boleto_bar_code: null, boleto_bank_line: null, pix_copy_paste: null, credit_correlation_armed: false, payment_in_flight: false, settlement: null, issuance_unconfirmed: false };
      },
      get: async () => { throw new Error("not called"); },
    };
    const rail = new CodeSparChargeRail(api as never);
    const base = { attempt_id: "att_x_0", mandate_id: "pol_1", amount_minor: 108000, currency: "BRL", payee: DEBTOR, beneficiary: "Joana Ribeiro", purpose: "cobranca", agent_id: "collections-agent", description: "Acordo #1042 - parcela 1/1", due_date: "2026-09-30", actor: { type: "agent" as const, agent: "collections-agent@0.1.0", on_behalf_of: "merchant_demo_loja" } };
    expect(await rail.pay(base)).toMatchObject({ status: "failed", code: "consumer_id_required" });
    expect(calls).toHaveLength(0);
    const out = await rail.pay({ ...base, consumer_id: "merchant_demo_loja" });
    expect(out).toMatchObject({ status: "accepted", transaction_id: "chg_wire_1", instrument: { payable: false, status: "PROCESSING" } });
    expect(calls[0]).toEqual({ path: "/v1/charges", body: { consumer_id: "merchant_demo_loja", amount: 1080, currency: "BRL", method: "boleto", description: "Acordo #1042 - parcela 1/1", buyer: { name: "Joana Ribeiro", document: DEBTOR }, due_date: "2026-09-30", idempotency_key: "att_x_0" } });
  });
});

describe("paySandboxCharge: the SDK's typed call to the payer route", () => {
  it("posts to /v1/test/charges/{id}/pay with the key, the project header and the amount; refuses a live key before any request", async () => {
    const { paySandboxCharge } = await import("../src/api/sandbox-payer.js");
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ charge_id: "chg_1", status: "paid", local_status: "settled", simulated: true, settled_against: "sandbox_fixture", money_moved: false, quoted_minor: 1000, paid_minor: 1000, payment: "full", idempotent_replay: false }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const live = await paySandboxCharge({ apiKey: ["csk", "live", "0000000000"].join("_") }, "chg_1").catch((e: Error) => e);
      expect(live).toBeInstanceOf(Error);
      expect(seen).toHaveLength(0);
      const out = await paySandboxCharge({ apiKey: "csk_test_unit_0000", baseUrl: "https://api.example.test/", projectId: "prj_1" }, "chg_1", 1000);
      expect(out).toMatchObject({ ok: true, state: { charge_id: "chg_1", status: "paid", simulated: true, money_moved: false } });
      expect(seen[0]?.url).toBe("https://api.example.test/v1/test/charges/chg_1/pay");
      const headers = new Headers(seen[0]?.init.headers);
      expect(headers.get("authorization")).toBe("Bearer csk_test_unit_0000");
      expect(headers.get("x-codespar-project")).toBe("prj_1");
      expect(headers.get("content-type")).toBe("application/json");
      expect(seen[0]?.init.body).toBe(JSON.stringify({ amount_minor: 1000 }));
      const bare = await paySandboxCharge({ apiKey: "csk_test_unit_0000", baseUrl: "https://api.example.test/", projectId: "prj_1" }, "chg_1");
      expect(bare).toMatchObject({ ok: true });
      expect(seen[1]?.init.body).toBe("{}");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("CodeSparChargeRail.read: a 409 is branched on its code, never on the status alone", () => {
  const VIEW = { id: "chg_409", status: "PROCESSING", local_status: "pending", status_conflict: false, method: "boleto", currency: "BRL", amount: 1080, amount_minor: 108000, due_date: "2026-09-30", payable: false, boleto_bar_code: null, boleto_bank_line: null, pix_copy_paste: null, credit_correlation_armed: false, payment_in_flight: false, settlement: null, issuance_unconfirmed: false };

  /** The real client over a stubbed fetch: the create answers `VIEW`, every read answers `readAnswer`. */
  function wired(readAnswer: { status: number; body?: unknown }) {
    const seen: Array<{ method: string; path: string }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      const { pathname } = new URL(String(url));
      const method = init?.method ?? "GET";
      seen.push({ method, path: pathname });
      const answer = method === "POST" ? { status: 200, body: VIEW } : readAnswer;
      return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { seen, fetchStub, rail: new CodeSparChargeRail(createCodeSparClient({ apiKey: "csk_test_unit_0000", baseUrl: "https://api.example.test/" })) };
  }

  async function withFetch<T>(fetchStub: typeof fetch, run: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchStub;
    try {
      return await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  const payment: RailPayment = { attempt_id: "att_409_0", mandate_id: "pol_1", amount_minor: 108000, currency: "BRL", payee: DEBTOR, purpose: "cobranca", agent_id: "collections-agent", consumer_id: "merchant_demo", due_date: "2026-09-30", actor: { type: "agent", agent: "collections-agent@0.1.0", on_behalf_of: "merchant_demo" } };
  const conflict = (code: string) => ({ status: 409, body: { error: { code, message: "conflict" }, request_id: null } });

  it("issuance_unconfirmed is the one 409 that means still issuing: in_flight, and the key is not read after the id", async () => {
    const w = wired(conflict("issuance_unconfirmed"));
    expect(await withFetch(w.fetchStub, () => w.rail.lookup(payment.attempt_id, payment, "chg_409"))).toEqual({ status: "in_flight" });
    expect(w.seen).toEqual([{ method: "GET", path: "/v1/charges/chg_409" }]);
  });

  it("charge_reference_ambiguous is terminal for the reference: failed with that code, by the id and by the key, and never polled as in flight", async () => {
    const byId = wired(conflict("charge_reference_ambiguous"));
    const outById = await withFetch(byId.fetchStub, () => byId.rail.lookup(payment.attempt_id, payment, "chg_409"));
    expect(outById).toMatchObject({ status: "failed", code: "charge_reference_ambiguous", message: expect.stringContaining("by the charge id") });
    expect(byId.seen).toEqual([{ method: "GET", path: "/v1/charges/chg_409" }]);

    const byKey = wired(conflict("charge_reference_ambiguous"));
    const outByKey = await withFetch(byKey.fetchStub, () => byKey.rail.lookup(payment.attempt_id, payment));
    expect(outByKey).toMatchObject({ status: "failed", code: "charge_reference_ambiguous", message: expect.stringContaining(payment.attempt_id) });
    expect(byKey.seen).toEqual([{ method: "GET", path: `/v1/charges/${payment.attempt_id}` }]);
  });

  it("a 409 with a code this kit does not read, or with no code at all, is a failure and not in_flight", async () => {
    const unknown = wired(conflict("charge_conflict_new_kind"));
    expect(await withFetch(unknown.fetchStub, () => unknown.rail.lookup(payment.attempt_id, payment, "chg_409"))).toMatchObject({ status: "failed", code: "charge_conflict_new_kind", message: expect.stringContaining("not read as a charge still issuing") });
    const bare = wired({ status: 409 });
    const out = await withFetch(bare.fetchStub, () => bare.rail.lookup(payment.attempt_id, payment, "chg_409"));
    expect(out).toMatchObject({ status: "failed" });
    expect(out).not.toEqual({ status: "in_flight" });
  });

  it("through the engine: an issued receivable whose read turns ambiguous closes failed (charge_reference_ambiguous), instead of staying executing", async () => {
    const w = wired(conflict("charge_reference_ambiguous"));
    const h = receivables({ dispatchTo: w.rail });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 108000, due_date: "2026-09-30", description: "acordo 1042, a vista" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await withFetch(w.fetchStub, () => h.engine.execute(d.execution.id));
    expect(issued).toMatchObject({ state: "executing", reason: "awaiting_settlement" });
    const closed = await withFetch(w.fetchStub, () => h.engine.reconcile(issued.id));
    expect(closed.state).toBe("failed");
    expect(closed.reason).toBe("charge_reference_ambiguous");
    expect(closed.history.at(-1)).toMatchObject({ from: "executing", to: "failed", reason: "charge_reference_ambiguous" });
  });

  it("reconcile, never reissue: resume and reconcile send nothing for it, and a new charge to the same payee is refused before it reaches the API", async () => {
    const w = wired(conflict("charge_reference_ambiguous"));
    const h = receivables({ dispatchTo: w.rail });
    const d = await h.engine.draft({ items: [{ payee: "acordo-1", amount: 108000, due_date: "2026-09-30" }] });
    if (!d.ok) throw new Error("refused");
    const issued = await withFetch(w.fetchStub, () => h.engine.execute(d.execution.id));
    const closed = await withFetch(w.fetchStub, () => h.engine.reconcile(issued.id));
    expect(closed.reason).toBe("charge_reference_ambiguous");
    const creates = () => w.seen.filter((r) => r.method === "POST" && r.path === "/v1/charges").length;
    expect(creates()).toBe(1);
    const requestsBefore = w.seen.length;

    // `resume` walks `executing` only, and both entry points return a terminal execution untouched.
    expect(h.engine.list({ state: "executing" })).toHaveLength(0);
    expect(await withFetch(w.fetchStub, () => h.engine.resumePending(closed.id))).toMatchObject({ state: "failed", reason: "charge_reference_ambiguous" });
    expect(await withFetch(w.fetchStub, () => h.engine.reconcile(closed.id))).toMatchObject({ state: "failed", reason: "charge_reference_ambiguous" });
    expect(w.seen.length).toBe(requestsBefore);

    // The same debt asked for again: denied at draft, nothing sent.
    const again = await withFetch(w.fetchStub, () => h.engine.draft({ items: [{ payee: "acordo-1", amount: 108000, due_date: "2026-10-15" }] }));
    expect(again).toMatchObject({ ok: true, execution: { state: "denied", reason: "charge_reference_ambiguous" } });
    expect(creates()).toBe(1);

    // Another payee is not held up by it.
    const other = await withFetch(w.fetchStub, () => h.engine.draft({ items: [{ payee: OTHER, amount: 5000, due_date: "2026-09-30" }] }));
    expect(other).toMatchObject({ ok: true, execution: { state: "approved" } });
  });
});
