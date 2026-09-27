/**
 * OPEN_QUESTIONS §18: the sealed receipt names the payee only when the spend
 * carries a `SpendQuote`. Every spend carries one, built from the approval
 * artifact's line; a spend without one, or with one that disagrees with the
 * money about to move, never reaches the API; and a receipt whose sealed
 * payee is not the payee that was paid is an error, not a line in a log.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiClient } from "@codespar/sdk";
import { describe, expect, it, vi } from "vitest";
import { hmacSigner } from "../src/approval.js";
import { CodeSparRail } from "../src/api/rail.js";
import { maskPayee } from "../src/bundle.js";
import { ReceiptSealMismatchError } from "../src/engine.js";
import { canonicalJson } from "../src/hash.js";
import { checkQuote } from "../src/quote.js";
import type { PaymentRail, RailPayment } from "../src/rail.js";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };
const actor = { type: "agent" as const, agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" };

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "att_quote_0",
    mandate_id: "mdt_test_0001",
    amount_minor: 185000,
    currency: "BRL",
    payee: ESCOLA,
    purpose: "contas do mes",
    agent_id: "bills-agent",
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: "2026-09-23T18:00:00.000Z" },
    approval: { items_hash: `sha256:${"1".repeat(64)}` },
    actor,
    ...over,
  };
}

/** An ApiClient that records what it was asked and answers a settled spend. */
function fakeApi(receiptBody?: unknown) {
  const post = vi.fn(async (_path: string, _init: { body: Record<string, unknown> }) => ({ payment: { transactionId: "tx_1", moneyMoved: false }, receipt: { id: "rcpt_1" } }));
  const get = vi.fn(async () => receiptBody);
  return { api: { post, get } as unknown as ApiClient, post, get };
}

/** The stub rail, but the receipt it hands back seals whatever payee the test says. */
function sealing(inner: PaymentRail, sealedPayee: string | null): PaymentRail {
  return {
    name: inner.name,
    pay: (p) => inner.pay(p),
    lookup: (id, p, tx) => inner.lookup(id, p, tx),
    receipt: async (id, a) => {
      const r = await inner.receipt(id, a);
      return r && { ...r, payment: { ...r.payment, payee: sealedPayee } };
    },
  };
}

describe("§18: every spend presents the quote of what was approved", () => {
  it("the quote is the approved line: seller, resource, price, payee and the moment of approval", async () => {
    const h = harness({ mode: "human" });
    const seen: RailPayment[] = [];
    const inner = h.rail;
    const pay = inner.pay.bind(inner);
    inner.pay = async (p) => (seen.push(p), pay(p));
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000, description: "outubro" }, { payee: "mercado", amount: 32000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const artifact = h.store.getApproval(approved.approval_id!)!;
    expect((await h.engine.execute(approved.id)).state).toBe("settled");

    expect(seen.map((p) => p.quote)).toEqual([
      { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: artifact.approved_at },
      // No description on the line: the resource is the mandate's purpose, never something the model adds later.
      { seller: "Mercado do Bairro", resource: "contas do mes", price_minor: 32000, payee: MERCADO, at: artifact.approved_at },
    ]);
  });

  it("the local receipt copy carries the payee the receipt sealed, masked", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const settled = await h.engine.execute(h.engine.approve(d.execution.id, approver).id);
    const copy = JSON.parse(readFileSync(join(h.bundle.dir, "receipts", `${settled.outcomes[0]!.receipt_id}.json`), "utf8"));
    expect(copy.payment.payee).toBe(maskPayee(ESCOLA));
    expect(JSON.stringify(copy)).not.toContain(ESCOLA);
  });

  it("an artifact whose line disagrees with the execution is refused before the call, even when its hash and signature hold", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    // A writer bug, not an attacker: the artifact's items no longer say what its items_hash says. Re-signed with the harness key.
    const { signature: _old, ...unsigned } = h.store.getApproval(approved.approval_id!)!;
    const drifted = { ...unsigned, items: unsigned.items.map((i) => ({ ...i, amount: 999 })) };
    h.store.saveApproval({ ...drifted, signature: { alg: "HMAC-SHA256", key_id: "test", value: hmacSigner("test", Buffer.alloc(32, 1)).sign(canonicalJson(drifted)) } });

    const denied = await h.engine.execute(approved.id);
    expect(denied.state).toBe("denied");
    expect(denied.reason).toBe("quote_mismatch");
    expect(h.rail.payCount).toBe(0);
  });
});

describe("§18: a spend that would not seal what was approved never goes out", () => {
  it("checkQuote: missing, wrong price, wrong payee", () => {
    expect(checkQuote(payment())).toMatchObject({ ok: true });
    const { quote: _q, ...bare } = payment();
    expect(checkQuote(bare)).toMatchObject({ ok: false, code: "quote_missing" });
    expect(checkQuote(payment({ amount_minor: 185001 }))).toMatchObject({ ok: false, code: "quote_mismatch" });
    expect(checkQuote(payment({ payee: MERCADO }))).toMatchObject({ ok: false, code: "quote_mismatch" });
  });

  it("the CodeSpar rail refuses a spend without a quote, and one that disagrees, without calling the API", async () => {
    const { api, post } = fakeApi();
    const rail = new CodeSparRail(api, { canonical: { any: "envelope" } as never, signature: "a".repeat(64) });
    const { quote: _q, ...bare } = payment();
    expect(await rail.pay(bare)).toMatchObject({ status: "failed", code: "quote_missing" });
    expect(await rail.pay(payment({ amount_minor: 1 }))).toMatchObject({ status: "failed", code: "quote_mismatch" });
    expect(await rail.pay(payment({ payee: MERCADO }))).toMatchObject({ status: "failed", code: "quote_mismatch" });
    expect(post).not.toHaveBeenCalled();
  });

  it("the CodeSpar rail sends the quote on both spend routes", async () => {
    const quote = payment().quote;
    const byEnvelope = fakeApi();
    await new CodeSparRail(byEnvelope.api, { canonical: { any: "envelope" } as never, signature: "a".repeat(64) }).pay(payment());
    expect(byEnvelope.post.mock.calls[0]![0]).toBe("/v1/consumer-payments/execute");
    expect(byEnvelope.post.mock.calls[0]![1].body["quote"]).toEqual(quote);
    const byId = fakeApi();
    await new CodeSparRail(byId.api).pay(payment());
    expect(byId.post.mock.calls[0]![0]).toBe("/v1/consumers/mandates/{id}/spend");
    expect(byId.post.mock.calls[0]![1].body["quote"]).toEqual(quote);
  });

  it("the stub rail makes the same refusal, so a scenario cannot pass without a quote", async () => {
    const h = harness();
    const { quote: _q, ...bare } = payment();
    expect(await h.rail.pay(bare)).toMatchObject({ status: "failed", code: "quote_missing" });
    expect(h.rail.payCount).toBe(0);
  });
});

describe("§18: the receipt's payee is the sealed one, and a mismatch is an error", () => {
  const sealed = (quote: unknown) => ({
    receipt_id: "rcpt_1",
    state: "paid",
    mandate: { id: "cm_1", nonce: "n", scope: "s", currency: "BRL", sig: "x" },
    quote,
    payment: { rail: "pix-consent", provider: "pix", tx_id: "tx_1", amount_minor: 185000, amount_atomic: null, sandbox: true, attempt_id: "att_quote_0", money_moved: false, at: "2026-09-23T18:00:01.000Z" },
    delivery: null,
    chain: "c".repeat(64),
    receipt_sig: "s",
    exceptions: [],
  });

  it("the CodeSpar rail reads the payee from the sealed quote, and null when the receipt sealed none", async () => {
    const withQuote = await new CodeSparRail(fakeApi(sealed({ seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, session_id: null, sig: "q", at: null })).api).receipt("rcpt_1", actor);
    expect(withQuote?.payment.payee).toBe(ESCOLA);
    const without = await new CodeSparRail(fakeApi(sealed(null)).api).receipt("rcpt_1", actor);
    expect(without?.payment.payee).toBeNull();
  });

  it("a mixed-case key sealed as it was sent raises nothing; the same key sealed lower-cased is a mismatch", async () => {
    const MIXED = "Financeiro@Escola-Aurora.example.com.br";
    const mandate = { merchant_allowlist: [MIXED] as [string], beneficiaries: [{ alias: "escola", name: "Escola Aurora", payee: MIXED }] as [{ alias: string; name: string; payee: string }] };
    const verbatim = harness({ mode: "human", mandate });
    const d1 = await verbatim.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d1.ok) throw new Error("refused");
    expect((await verbatim.engine.execute(verbatim.engine.approve(d1.execution.id, approver).id)).state).toBe("settled");
    expect(verbatim.bundle.readEvents().some((e) => e["type"] === "receipt.seal_mismatch")).toBe(false);

    // The API stores and returns quote.payee verbatim (OPEN_QUESTIONS §18); if that ever changes, this is what the kit says.
    const lowered = harness({ mode: "human", mandate, wrapRail: (stub) => sealing(stub, MIXED.toLowerCase()) });
    const d2 = await lowered.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d2.ok) throw new Error("refused");
    await expect(lowered.engine.execute(lowered.engine.approve(d2.execution.id, approver).id)).rejects.toBeInstanceOf(ReceiptSealMismatchError);
  });

  for (const [label, sealedPayee] of [["a different payee", MERCADO], ["no payee at all (a spend the API sealed without a quote)", null]] as const) {
    it(`a receipt sealing ${label} throws after the outcome is saved, and the bundle says why without the key in the clear`, async () => {
      const h = harness({ mode: "human", wrapRail: (stub) => sealing(stub, sealedPayee) });
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
      if (!d.ok) throw new Error("refused");
      const approved = h.engine.approve(d.execution.id, approver);

      await expect(h.engine.execute(approved.id)).rejects.toBeInstanceOf(ReceiptSealMismatchError);
      // The money is recorded where the rail put it; the error is about the evidence.
      expect(h.engine.get(approved.id)?.state).toBe("settled");
      const mismatch = h.bundle.readEvents().find((e) => e["type"] === "receipt.seal_mismatch");
      expect(mismatch?.["payload"]).toMatchObject({ sealed_payee: sealedPayee === null ? null : maskPayee(sealedPayee), paid_payee: maskPayee(ESCOLA) });
      expect(JSON.stringify(mismatch)).not.toContain(ESCOLA);
      if (sealedPayee) expect(JSON.stringify(mismatch)).not.toContain(sealedPayee);
    });
  }
});
