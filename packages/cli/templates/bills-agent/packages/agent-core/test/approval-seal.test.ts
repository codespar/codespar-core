/**
 * OPEN_QUESTIONS §3: every spend carries the approval artifact's hashes, and
 * the API seals them into the receipt's chain (v4, ent#1670). What is sent is
 * the artifact's own `items_hash`, and for a batch line its `batch_hash` —
 * the values the artifact's HMAC covers — and nothing the execution says
 * later. A spend without them, or with a shape the API would refuse, never
 * goes out; the bundle's receipt copy names the artifact by id so `verify`
 * finds it by identity.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiClient } from "@codespar/sdk";
import { describe, expect, it, vi } from "vitest";
import { CodeSparRail } from "../src/api/rail.js";
import { copyDisagreesWithRead, maskPayee } from "../src/bundle.js";
import { ReceiptSealMismatchError } from "../src/engine.js";
import { checkSpendApproval, spendApprovalOf, type PaymentRail, type RailPayment, type SealedSpendApproval } from "../src/rail.js";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

const approver = { id: "usr_demo", channel: "terminal" };
const actor = { type: "agent" as const, agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" };
const ITEMS_HASH = `sha256:${"1".repeat(64)}`;

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "att_seal_0",
    mandate_id: "mdt_test_0001",
    amount_minor: 185000,
    currency: "BRL",
    payee: ESCOLA,
    purpose: "contas do mes",
    agent_id: "bills-agent",
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: "2026-09-23T18:00:00.000Z" },
    approval: { items_hash: ITEMS_HASH },
    actor,
    ...over,
  };
}

function fakeApi(receiptBody?: unknown) {
  const post = vi.fn(async (_path: string, _init: { body: Record<string, unknown> }) => ({ payment: { transactionId: "tx_1", moneyMoved: false }, receipt: { id: "rcpt_1" } }));
  return { api: { post, get: vi.fn(async () => receiptBody) } as unknown as ApiClient, post };
}

/** The stub rail, but the receipt it hands back seals whatever approval the test says. */
function sealingApproval(sealed: SealedSpendApproval | null) {
  return (inner: PaymentRail): PaymentRail => ({
    name: inner.name,
    pay: (p) => inner.pay(p),
    lookup: (id, p, tx) => inner.lookup(id, p, tx),
    receipt: async (id, a) => {
      const r = await inner.receipt(id, a);
      return r && { ...r, approval: sealed };
    },
  });
}

function recording() {
  const h = harness({ mode: "human" });
  const seen: RailPayment[] = [];
  const pay = h.rail.pay.bind(h.rail);
  h.rail.pay = async (p) => (seen.push(p), pay(p));
  return { h, seen };
}

describe("every spend presents the artifact's hashes", () => {
  it("a single execution: the artifact's items_hash on every line, no batch_hash, and the quote keeps the moment of approval", async () => {
    const { h, seen } = recording();
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }, { payee: "mercado", amount: 32000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const artifact = h.store.getApproval(approved.approval_id!)!;
    expect((await h.engine.execute(approved.id)).state).toBe("settled");
    expect(seen.map((p) => p.approval)).toEqual([{ items_hash: artifact.items_hash }, { items_hash: artifact.items_hash }]);
    expect(seen.map((p) => p.quote?.at)).toEqual([artifact.approved_at, artifact.approved_at]);
    // The form the API seals a timestamp in (RFC 3339, UTC, milliseconds), so the read gives back what was sent (ent#1670).
    expect(artifact.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // What the "provider" holds for the attempt is what was sent.
    expect((h.store.stubRailGet(seen[0]!.attempt_id)!.request as RailPayment).approval).toEqual({ items_hash: artifact.items_hash });
  });

  it("a batch line: the line's items_hash and the batch's batch_hash, and a quote with no time in it", async () => {
    const { h, seen } = recording();
    const batch = { ref: "folha-teste", batch_hash: `sha256:${"a".repeat(64)}`, index: 0, count: 2 };
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }], batch });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const artifact = h.store.getApproval(approved.approval_id!)!;
    await h.engine.execute(approved.id);
    expect(seen[0]!.approval).toEqual({ items_hash: artifact.items_hash, batch_hash: batch.batch_hash });
    expect(seen[0]!.quote).not.toHaveProperty("at");
  });

  it("spendApprovalOf carries exactly the artifact's two hashes", () => {
    expect(spendApprovalOf({ items_hash: ITEMS_HASH })).toEqual({ items_hash: ITEMS_HASH });
    expect(spendApprovalOf({ items_hash: ITEMS_HASH, batch: { ref: "r", batch_hash: `sha256:${"b".repeat(64)}`, index: 1, count: 3 } })).toEqual({ items_hash: ITEMS_HASH, batch_hash: `sha256:${"b".repeat(64)}` });
  });
});

describe("the CodeSpar rail", () => {
  it("sends approval on both spend routes, as the artifact spells it", async () => {
    const withBatch = { items_hash: ITEMS_HASH, batch_hash: `sha256:${"b".repeat(64)}` };
    const byEnvelope = fakeApi();
    await new CodeSparRail(byEnvelope.api, { canonical: { any: "envelope" } as never, signature: "a".repeat(64) }).pay(payment({ approval: withBatch }));
    expect(byEnvelope.post.mock.calls[0]![0]).toBe("/v1/consumer-payments/execute");
    expect(byEnvelope.post.mock.calls[0]![1].body["approval"]).toEqual(withBatch);
    const byId = fakeApi();
    await new CodeSparRail(byId.api).pay(payment());
    expect(byId.post.mock.calls[0]![0]).toBe("/v1/consumers/mandates/{id}/spend");
    expect(byId.post.mock.calls[0]![1].body["approval"]).toEqual({ items_hash: ITEMS_HASH });
  });

  it("refuses a spend without it, or with a hash the API would refuse, without calling the API", async () => {
    const { api, post } = fakeApi();
    const rail = new CodeSparRail(api);
    const { approval: _a, ...bare } = payment();
    expect(await rail.pay(bare)).toMatchObject({ status: "failed", code: "approval_missing" });
    expect(await rail.pay(payment({ approval: { items_hash: "sha256:ABC" } }))).toMatchObject({ status: "failed", code: "approval_malformed" });
    expect(await rail.pay(payment({ approval: { items_hash: ITEMS_HASH, batch_hash: "f".repeat(63) } }))).toMatchObject({ status: "failed", code: "approval_malformed" });
    expect(post).not.toHaveBeenCalled();
  });

  it("checkSpendApproval accepts the two spellings the API accepts", () => {
    expect(checkSpendApproval({ approval: { items_hash: ITEMS_HASH } }).ok).toBe(true);
    expect(checkSpendApproval({ approval: { items_hash: "1".repeat(64) } }).ok).toBe(true);
    expect(checkSpendApproval({ approval: { items_hash: `sha256:${"1".repeat(64)}`.toUpperCase() } }).ok).toBe(false);
  });
});

describe("the receipt seals the approval the spend sent, or the run stops", () => {
  it("the CodeSpar rail reads chain_version, the sealed approval and sig_sha256 through the SDK's types", async () => {
    const read = {
      receipt_id: "rcpt_1",
      state: "paid",
      chain_version: 4,
      mandate: { id: "cm_1", nonce: "n", scope: "s", currency: "BRL", sig: "x", sig_sha256: "d".repeat(64) },
      quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, session_id: null, sig: "q", at: "2026-09-23T18:00:00.000Z" },
      approval: { items_hash: ITEMS_HASH, batch_hash: null },
      payment: { rail: "pix-consent", provider: "pix", tx_id: "tx_1", amount_minor: 185000, amount_atomic: null, sandbox: true, attempt_id: "att_seal_0", money_moved: false, at: "2026-09-23T18:00:01.000Z" },
      delivery: null,
      chain: "c".repeat(64),
      receipt_sig: "s",
      exceptions: [],
    };
    const receipt = await new CodeSparRail(fakeApi(read).api).receipt("rcpt_1", actor);
    expect(receipt).toMatchObject({ chain_version: 4, approval: { items_hash: ITEMS_HASH, batch_hash: null }, mandate: { id: "cm_1", sig_sha256: "d".repeat(64) } });
    expect(JSON.stringify({ ...receipt, raw: undefined })).not.toContain('"sig":"x"');
    const { approval: _a, ...older } = read;
    expect((await new CodeSparRail(fakeApi({ ...older, chain_version: 1 }).api).receipt("rcpt_1", actor))?.approval).toBeNull();
  });

  for (const [name, sealed] of [
    ["another list", { items_hash: `sha256:${"9".repeat(64)}`, batch_hash: null }],
    ["no approval at all", null],
  ] as const) {
    it(`a receipt that seals ${name} is ReceiptSealMismatchError, after the outcome is saved`, async () => {
      const h = harness({ mode: "human", wrapRail: sealingApproval(sealed) });
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
      if (!d.ok) throw new Error("refused");
      const approved = h.engine.approve(d.execution.id, approver);
      const artifact = h.store.getApproval(approved.approval_id!)!;
      await expect(h.engine.execute(approved.id)).rejects.toBeInstanceOf(ReceiptSealMismatchError);
      expect(h.engine.get(approved.id)?.state).toBe("settled");
      const mismatch = h.bundle.readEvents().find((e) => e["type"] === "receipt.seal_mismatch");
      expect(mismatch?.["payload"]).toMatchObject({ sealed_approval: sealed, sent_approval: { items_hash: artifact.items_hash } });
    });
  }

  it("the same hash in the other spelling of the prefix is the same approval", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const bare = h.store.getApproval(approved.approval_id!)!.items_hash.replace(/^sha256:/, "");
    const spelled = harness({ mode: "human", dir: h.dir, wrapRail: sealingApproval({ items_hash: bare, batch_hash: null }) });
    expect((await spelled.engine.execute(approved.id)).state).toBe("settled");
    expect(spelled.bundle.readEvents().some((e) => e["type"] === "receipt.seal_mismatch")).toBe(false);
  });
});

describe("the stub rail", () => {
  it("makes the same refusal, so a scenario cannot pass without the hashes", async () => {
    const h = harness();
    const { approval: _a, ...bare } = payment();
    expect(await h.rail.pay(bare)).toMatchObject({ status: "failed", code: "approval_missing" });
    expect(h.rail.payCount).toBe(0);
  });

  it("answers a repeat under a different approval as attempt_id_conflict naming it, the way the API's fingerprint does (ent#1670)", async () => {
    const h = harness();
    expect(await h.rail.pay(payment())).toMatchObject({ status: "settled" });
    const other = await h.rail.pay(payment({ approval: { items_hash: `sha256:${"9".repeat(64)}` } }));
    expect(other).toMatchObject({ status: "failed", code: "attempt_id_conflict", held: "conflict" });
    expect((other as { message: string }).message).toContain("approval");
    expect(h.rail.payCount).toBe(1);
  });
});

describe("the bundle's receipt copy", () => {
  it("names the artifact the spend carried, by id, and stays masked", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 185000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    const settled = await h.engine.execute(approved.id);
    const copy = JSON.parse(readFileSync(join(h.bundle.dir, "receipts", `${settled.outcomes[0]!.receipt_id}.json`), "utf8")) as Record<string, unknown>;
    expect(copy["approval_id"]).toBe(approved.approval_id);
    expect(h.bundle.readApprovals().map((a) => a.approval_id)).toContain(copy["approval_id"]);
    expect(JSON.stringify(copy)).not.toContain(ESCOLA);
  });

  it("is held against the read field by field, the payee in its masked form", () => {
    const read = {
      receipt_id: "rcpt_1",
      chain: "c".repeat(64),
      mandate: { id: "cm_1", nonce: "n" },
      quote: { payee: ESCOLA },
      payment: { rail: "pix", amount_minor: 185000, attempt_id: "att_0", money_moved: false, at: "2026-09-26T18:00:01.000Z" },
    };
    const copy = { receipt_id: "rcpt_1", chain: "c".repeat(64), mandate: { id: "cm_1" }, payment: { amount_minor: 185000, payee: maskPayee(ESCOLA), attempt_id: "att_0", money_moved: false, sandbox: true, at: "2026-09-26T18:00:01.000Z" } };
    expect(copyDisagreesWithRead(copy, read)).toEqual([]);
    expect(copyDisagreesWithRead({ ...copy, payment: { ...copy.payment, amount_minor: 1 } }, read)).toEqual(["payment.amount_minor"]);
    expect(copyDisagreesWithRead({ ...copy, payment: { ...copy.payment, payee: maskPayee(MERCADO) } }, read)).toEqual(["payment.payee"]);
    expect(copyDisagreesWithRead({ ...copy, chain: "d".repeat(64) }, read)).toEqual(["chain"]);
    // A copy written since 0.16.10 carries what was sealed, and is held to it; one from before carries neither and is not faulted.
    const sealedRead = { ...read, chain_version: 4, approval: { items_hash: ITEMS_HASH, batch_hash: null } };
    const sealedCopy = { ...copy, chain_version: 4, approval: { batch_hash: null, items_hash: ITEMS_HASH } };
    expect(copyDisagreesWithRead(sealedCopy, sealedRead)).toEqual([]);
    expect(copyDisagreesWithRead({ ...sealedCopy, approval: { items_hash: `sha256:${"9".repeat(64)}`, batch_hash: null } }, sealedRead)).toEqual(["approval"]);
    expect(copyDisagreesWithRead({ ...sealedCopy, chain_version: 3 }, sealedRead)).toEqual(["chain_version"]);
    expect(copyDisagreesWithRead(copy, sealedRead)).toEqual([]);
  });
});
