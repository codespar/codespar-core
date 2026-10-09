/**
 * OPEN_QUESTIONS §2: every spend carries the kit's `actor` on the wire, in the
 * API's `PaymentActor` shape (@codespar/sdk 0.16.10); the receipt reads it
 * back; the engine compares what came back with what was sent, and a
 * different actor, or none, is an event in the bundle.
 */
import type { ApiClient } from "@codespar/sdk";
import { describe, expect, it, vi } from "vitest";
import { CodeSparRail } from "../src/api/rail.js";
import { copyDisagreesWithRead } from "../src/bundle.js";
import { sameWireActor, wireActorOf, type PaymentRail, type RailPayment, type WireActor } from "../src/rail.js";
import type { Actor } from "../src/types.js";
import { ESCOLA, harness } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };
const agentActor: Actor = { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" };
const ITEMS_HASH = `sha256:${"1".repeat(64)}`;

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "att_actor_0",
    mandate_id: "mdt_test_0001",
    amount_minor: 185000,
    currency: "BRL",
    payee: ESCOLA,
    purpose: "contas do mes",
    agent_id: "bills-agent",
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: "2026-09-23T18:00:00.000Z" },
    approval: { items_hash: ITEMS_HASH },
    actor: agentActor,
    ...over,
  };
}

function fakeApi(receiptBody?: unknown) {
  const post = vi.fn(async (_path: string, _init: { body: Record<string, unknown> }) => ({ payment: { transactionId: "tx_1", moneyMoved: false }, receipt: { id: "rcpt_1" } }));
  return { api: { post, get: vi.fn(async () => receiptBody) } as unknown as ApiClient, post };
}

/** The stub rail, but the receipt it hands back records whatever actor the test says. */
function recordingActor(sealed: WireActor | null) {
  return (inner: PaymentRail): PaymentRail => ({
    name: inner.name,
    pay: (p) => inner.pay(p),
    lookup: (id, p, tx) => inner.lookup(id, p, tx),
    receipt: async (id, a) => {
      const r = await inner.receipt(id, a);
      return r && { ...r, sealed_actor: sealed };
    },
  });
}

describe("the actor, in the API's shape", () => {
  it("an agent is its identifier and the consumer it acts for; a person is an id and the channel they acted from", () => {
    expect(wireActorOf(agentActor)).toEqual({ type: "agent", id: "bills-agent@0.1.0", on_behalf_of: "usr_demo" });
    expect(wireActorOf({ type: "human", id: "usr_ana", channel: "whatsapp" })).toEqual({ type: "human", id: "usr_ana", channel: "whatsapp" });
  });

  it("the same actor is the same on every field, and the channel counts", () => {
    const person: WireActor = { type: "human", id: "usr_ana", channel: "whatsapp" };
    expect(sameWireActor(person, { ...person })).toBe(true);
    expect(sameWireActor(person, { ...person, channel: "dashboard" })).toBe(false);
    expect(sameWireActor(wireActorOf(agentActor), { type: "agent", id: "bills-agent@0.1.0", on_behalf_of: "usr_other" })).toBe(false);
    expect(sameWireActor(wireActorOf(agentActor), person)).toBe(false);
    expect(sameWireActor(null, wireActorOf(agentActor))).toBe(false);
    expect(sameWireActor(null, null)).toBe(true);
  });
});

describe("the CodeSpar rail sends it and reads it back", () => {
  it("both spend routes carry the actor, not only agent_id", async () => {
    const byEnvelope = fakeApi();
    await new CodeSparRail(byEnvelope.api, { canonical: { any: "envelope" } as never, signature: "a".repeat(64) }).pay(payment());
    expect(byEnvelope.post.mock.calls[0]![0]).toBe("/v1/consumer-payments/execute");
    expect(byEnvelope.post.mock.calls[0]![1].body["actor"]).toEqual({ type: "agent", id: "bills-agent@0.1.0", on_behalf_of: "usr_demo" });
    const byId = fakeApi();
    await new CodeSparRail(byId.api).pay(payment({ actor: { type: "human", id: "usr_ana", channel: "whatsapp" } }));
    expect(byId.post.mock.calls[0]![0]).toBe("/v1/consumers/mandates/{id}/spend");
    expect(byId.post.mock.calls[0]![1].body["actor"]).toEqual({ type: "human", id: "usr_ana", channel: "whatsapp" });
    // agent_id still goes: it names who the mandate was signed for, which is an authority and not the event.
    expect(byId.post.mock.calls[0]![1].body["agent_id"]).toBe("bills-agent");
  });

  it("the receipt read gives back the actor the API recorded, and null when it recorded none", async () => {
    const read = {
      receipt_id: "rcpt_1",
      state: "paid",
      chain_version: 4,
      actor: { type: "agent", id: "bills-agent@0.1.0", on_behalf_of: "usr_demo" },
      mandate: { id: "cm_1", nonce: "n", scope: "s", currency: "BRL", sig: "x", sig_sha256: "d".repeat(64) },
      quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, session_id: null, sig: "q", at: "2026-09-23T18:00:00.000Z" },
      approval: { items_hash: ITEMS_HASH, batch_hash: null },
      payment: { rail: "pix-consent", provider: "pix", tx_id: "tx_1", amount_minor: 185000, amount_atomic: null, sandbox: true, attempt_id: "att_actor_0", money_moved: false, at: "2026-09-23T18:00:01.000Z" },
      delivery: null,
      chain: "c".repeat(64),
      receipt_sig: "s",
      exceptions: [],
    };
    const receipt = await new CodeSparRail(fakeApi(read).api).receipt("rcpt_1", agentActor);
    expect(receipt?.sealed_actor).toEqual({ type: "agent", id: "bills-agent@0.1.0", on_behalf_of: "usr_demo" });
    // The local stamp stays the kit's own: the two are compared, never merged.
    expect(receipt?.actor).toEqual(agentActor);
    expect((await new CodeSparRail(fakeApi({ ...read, actor: null }).api).receipt("rcpt_1", agentActor))?.sealed_actor).toBeNull();
  });
});

describe("the engine compares what came back with what was sent", () => {
  const run = async (wrap?: (inner: PaymentRail) => PaymentRail) => {
    const h = harness({ mode: "human", ...(wrap ? { wrapRail: wrap } : {}) });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const done = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    return { h, done };
  };

  it("the same actor back: nothing to say, and the bundle's receipt copy carries both the stamp and what the API recorded", async () => {
    const { h, done } = await run();
    expect(done.state).toBe("settled");
    expect(h.bundle.readEvents().some((e) => e["type"] === "receipt.actor_mismatch")).toBe(false);
    const copy = h.bundle.readReceipt(h.bundle.listReceipts()[0]!)!;
    expect(copy["sealed_actor"]).toEqual(wireActorOf(h.engine.agentActor));
    expect(copy["actor"]).toEqual(h.engine.agentActor);
  });

  for (const [name, sealed] of [
    ["another actor", { type: "human", id: "usr_intruso", channel: "dashboard" } as WireActor],
    ["no actor at all", null],
  ] as const) {
    it(`a receipt that records ${name} is a receipt.actor_mismatch event; the payment stands`, async () => {
      const { h, done } = await run(recordingActor(sealed));
      expect(done.state).toBe("settled");
      const mismatch = h.bundle.readEvents().find((e) => e["type"] === "receipt.actor_mismatch");
      expect(mismatch?.["payload"]).toMatchObject({ sealed_actor: sealed, sent_actor: wireActorOf(h.engine.agentActor) });
      expect(mismatch?.["actor"]).toBeDefined();
    });
  }

  it("verify's copy check flags a copy whose recorded actor is not the read's", () => {
    const read = { receipt_id: "r", chain: "c", mandate: { id: "m" }, payment: { amount_minor: 1, attempt_id: "a", money_moved: false, at: "t" }, actor: { type: "agent", id: "x", on_behalf_of: "u" } };
    const copy = { receipt_id: "r", chain: "c", mandate: { id: "m" }, payment: { amount_minor: 1, attempt_id: "a", money_moved: false, at: "t", payee: null }, sealed_actor: { type: "agent", id: "y", on_behalf_of: "u" } };
    expect(copyDisagreesWithRead(copy, read)).toEqual(["sealed_actor"]);
    expect(copyDisagreesWithRead({ ...copy, sealed_actor: read.actor }, read)).toEqual([]);
  });
});
