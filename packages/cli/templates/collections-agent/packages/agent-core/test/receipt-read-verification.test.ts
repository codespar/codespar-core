/**
 * `verifyReceiptRead`: the signature, then the body, then the approval
 * (OPEN_QUESTIONS §3, §47). Every case is one that must be able to fail, and
 * the ones that matter most are the ones that must NOT say `verified`: a v1–v3
 * chain, a masked payee, a copy without its read, a document without a recipe.
 *
 * The chain a case is signed over is computed here by hand — `canonicalize`
 * over the link list written out field by field, the RFC 8785 half of which is
 * held to the RFC's examples in `receipt-chain.test.ts` — and signed with
 * stock `node:crypto` and a key generated in the test, never with the module
 * under test. The recipe is the one production published on 2026-09-26.
 */
import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { itemsHash } from "../src/hash.js";
import { canonicalize } from "../src/receipt-chain.js";
import { VERDICT_EXIT_CODES, isReceiptRead, verifyReceiptRead, type ApprovalClaim } from "../src/receipt-verification.js";
import type { ExecutionItem } from "../src/types.js";

const PUBLISHED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "production-receipt-keys.json"), "utf8")) as Record<string, unknown>;
const KID = "did:web:id.codespar.dev#production-2";
const RECEIPT_ID = "rcpt_V1StGXR8Z5jdHi6BmyT0sw";
const MANDATE_SIG = "a".repeat(64);
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const ITEMS: ExecutionItem[] = [{ alias: "escola", beneficiary: "Escola Aurora", payee: "escola@exemplo.com.br", amount: 185000, currency: "BRL", description: "outubro" }];
const ITEMS_HASH = itemsHash(ITEMS);
const BATCH_HASH = `sha256:${"2".repeat(64)}`;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const X = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");

/** The production document, with this test's public key under the production kid in place of CodeSpar's. */
function keyDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...PUBLISHED, keys: [{ kid: KID, kty: "OKP", crv: "Ed25519", x: X, alg: "EdDSA", use: "sig", status: "active" }], ...over };
}

function body(version: number, approval: { items_hash: string; batch_hash: string | null } | null, over: { payee?: string; amount?: number } = {}) {
  const payee = over.payee ?? "escola@exemplo.com.br";
  const amount = over.amount ?? 185000;
  return {
    mandate: { id: "cm_test_1", nonce: "nonce-1", scope: "contas do mes", currency: "BRL", sig: MANDATE_SIG, sig_sha256: sha256(MANDATE_SIG) },
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: amount, payee, session_id: null, sig: "q".repeat(64), at: "2026-09-26T18:00:00.000Z" },
    payment: { rail: "pix-consent", provider: "pix", tx_id: "tx_1", amount_minor: amount, amount_atomic: null, sandbox: true, attempt_id: "att_1_0", money_moved: false, at: "2026-09-26T18:00:01.000Z" },
    ...(version === 4 ? { approval } : {}),
  };
}

/** The chain written out link by link, the way the recipe says and not the way the module under test builds it. */
function chainOf(version: number, b: ReturnType<typeof body>): string {
  const m = b.mandate;
  const q = b.quote;
  const p = b.payment;
  const links: unknown[] = [
    version === 4 ? { id: m.id, nonce: m.nonce, scope: m.scope, currency: m.currency, sig_sha256: m.sig_sha256 } : { id: m.id, nonce: m.nonce, scope: m.scope, currency: m.currency, sig: m.sig },
    { seller: q.seller, resource: q.resource, price_minor: q.price_minor, payee: q.payee, session_id: q.session_id, sig: q.sig, at: q.at },
    ...(version === 4 ? [b.approval] : []),
    { rail: p.rail, provider: p.provider, tx_id: p.tx_id, amount_minor: p.amount_minor, sandbox: true, attempt_id: p.attempt_id, money_moved: p.money_moved, at: p.at },
  ];
  return sha256(canonicalize({ v: version, links }));
}

function sealed(version: number, approval: { items_hash: string; batch_hash: string | null } | null = { items_hash: ITEMS_HASH, batch_hash: null }, key: KeyObject = privateKey) {
  const b = body(version, approval);
  const chain = chainOf(version, b);
  return {
    receipt_id: RECEIPT_ID,
    state: "paid",
    chain_version: version,
    ...b,
    delivery: null,
    chain,
    receipt_sig: "hmac-not-read-here",
    receipt_sig_ed25519: signDetached(null, Buffer.from(`codespar-receipt:v1:${RECEIPT_ID}:${chain}`, "utf8"), key).toString("base64url"),
    receipt_sig_kid: KID,
    exceptions: [],
  } as Record<string, unknown>;
}

const artifact = (over: Partial<ApprovalClaim> = {}): ApprovalClaim => ({ approval_id: "apr_1", items_hash: ITEMS_HASH, items: ITEMS, ...over });

describe("a v4 receipt: signature, body and approval", () => {
  it("is verified when all three hold, and says which list it was paid against", () => {
    const report = verifyReceiptRead(sealed(4), keyDocument(), { approval: artifact() });
    expect(report.verdict).toBe("verified");
    expect(report.chain_check).toMatchObject({ status: "recomputed", version: 4 });
    expect(report.approval_check).toMatchObject({ status: "matched", sealed: { items_hash: ITEMS_HASH, batch_hash: null }, artifact: { approval_id: "apr_1" } });
    expect(report.message).toContain(ITEMS_HASH);
    expect(report.message).toContain("WHO approved it is in the artifact");
  });

  it("verifies without the mandate's signature on the read: a third party is never handed it", () => {
    const read = sealed(4);
    const { sig: _sig, ...mandate } = read["mandate"] as Record<string, unknown>;
    expect(verifyReceiptRead({ ...read, mandate }, keyDocument(), { approval: artifact() }).verdict).toBe("verified");
  });

  it("is approval_mismatch when the sealed items_hash is not the artifact's", () => {
    const other = `sha256:${"9".repeat(64)}`;
    const report = verifyReceiptRead(sealed(4, { items_hash: other, batch_hash: null }), keyDocument(), { approval: artifact() });
    expect(report.verdict).toBe("approval_mismatch");
    expect(report.reason).toBe("items_hash_differs");
    expect(report.approval_check).toMatchObject({ status: "mismatch", sealed: { items_hash: other } });
    expect(VERDICT_EXIT_CODES[report.verdict]).toBe(9);
  });

  it("is approval_mismatch when the batch differs, in either direction", () => {
    expect(verifyReceiptRead(sealed(4, { items_hash: ITEMS_HASH, batch_hash: BATCH_HASH }), keyDocument(), { approval: artifact() })).toMatchObject({ verdict: "approval_mismatch", reason: "batch_hash_differs" });
    expect(verifyReceiptRead(sealed(4), keyDocument(), { approval: artifact({ batch: { batch_hash: BATCH_HASH } }) })).toMatchObject({ verdict: "approval_mismatch", reason: "batch_hash_differs" });
    expect(verifyReceiptRead(sealed(4, { items_hash: ITEMS_HASH, batch_hash: BATCH_HASH }), keyDocument(), { approval: artifact({ batch: { batch_hash: BATCH_HASH } }) }).verdict).toBe("verified");
  });

  it("is approval_mismatch when the artifact's items were edited under its hash: a hash that does not describe its list proves nothing", () => {
    const edited = [{ ...ITEMS[0]!, payee: "outra@exemplo.com.br" }];
    expect(verifyReceiptRead(sealed(4), keyDocument(), { approval: artifact({ items: edited }) })).toMatchObject({ verdict: "approval_mismatch", reason: "artifact_items_hash_inconsistent" });
  });

  it("is verified, approval not compared, when no artifact is given — and prints the sealed hash to compare by hand", () => {
    const report = verifyReceiptRead(sealed(4), keyDocument());
    expect(report.verdict).toBe("verified");
    expect(report.approval_check).toMatchObject({ status: "not_compared", artifact: null });
    expect(report.message).toContain(ITEMS_HASH);
  });

  it("is chain_mismatch when the body beside a genuine signature was changed: payee, amount, approval", () => {
    const read = sealed(4);
    const q = read["quote"] as Record<string, unknown>;
    const p = read["payment"] as Record<string, unknown>;
    for (const altered of [
      { ...read, quote: { ...q, payee: "outra@exemplo.com.br" } },
      { ...read, payment: { ...p, amount_minor: 1 } },
      { ...read, approval: { items_hash: `sha256:${"9".repeat(64)}`, batch_hash: null } },
    ]) {
      const report = verifyReceiptRead(altered, keyDocument(), { approval: artifact() });
      expect(report.verdict).toBe("chain_mismatch");
      expect(report.chain_check).toMatchObject({ status: "mismatch", version: 4 });
      expect(VERDICT_EXIT_CODES[report.verdict]).toBe(8);
    }
  });

  it("recomputes under the recipe of the document it was given: a different published order is a different chain", () => {
    const base = PUBLISHED["chain_recipe"] as { links: unknown[] };
    const [mandate, quote, approval, payment, delivery] = base.links;
    const reordered = keyDocument({ chain_recipe: { ...base, links: [mandate, approval, quote, payment, delivery] } });
    expect(verifyReceiptRead(sealed(4), reordered).verdict).toBe("chain_mismatch");
  });

  it("stops at the signature: a body check never runs on a receipt whose signature failed", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    const report = verifyReceiptRead(sealed(4, undefined, other), keyDocument(), { approval: artifact() });
    expect(report.verdict).toBe("tampered");
    expect(report.chain_check).toBeUndefined();
  });
});

describe("what is never `verified`", () => {
  for (const version of [1, 2, 3]) {
    it(`a v${version} receipt: the chain is not recomputable without the mandate signature, even from a read that carries it`, () => {
      const report = verifyReceiptRead(sealed(version, null), keyDocument(), { approval: artifact() });
      expect(report.verdict).toBe("signature_only");
      expect(report.reason).toBe("mandate_sig_required");
      expect(report.message).toContain("not recomputable without the mandate signature");
      expect(report.chain_check).toMatchObject({ status: "not_recomputed", version });
      expect(report.approval_check).toBeUndefined();
    });
  }

  it("a v2 receipt whose body was edited is signature_only too, never chain_mismatch: a pre-ent#1670 read may not recompute, and a mismatch there would accuse a genuine receipt", () => {
    const read = sealed(2, null);
    expect(verifyReceiptRead({ ...read, payment: { ...(read["payment"] as object), amount_minor: 1 } }, keyDocument()).verdict).toBe("signature_only");
  });

  it("a read with a masked payee", () => {
    const read = sealed(4);
    const report = verifyReceiptRead({ ...read, quote: { ...(read["quote"] as object), payee: "es***@exemplo.com.br" } }, keyDocument(), { approval: artifact() });
    expect(report).toMatchObject({ verdict: "signature_only", reason: "payee_masked" });
  });

  it("the proof bundle's copy, which carries none of the links", () => {
    const read = sealed(4);
    const copy = { receipt_id: RECEIPT_ID, state: "paid", mandate: { id: "cm_test_1" }, payment: { amount_minor: 185000, payee: "es***@exemplo.com.br", attempt_id: "att_1_0", money_moved: false, sandbox: true, at: "2026-09-26T18:00:01.000Z" }, chain: read["chain"], receipt_sig: "x", receipt_sig_ed25519: read["receipt_sig_ed25519"], receipt_sig_kid: KID };
    expect(isReceiptRead(copy)).toBe(false);
    expect(verifyReceiptRead(copy, keyDocument())).toMatchObject({ verdict: "signature_only", reason: "read_required" });
  });

  it("a key set from a deployment that publishes no recipe", () => {
    const { chain_recipe: _r, ...older } = keyDocument();
    expect(verifyReceiptRead(sealed(4), older, { approval: artifact() })).toMatchObject({ verdict: "signature_only", reason: "recipe_unpublished" });
  });

  it("keeps every verdict's exit code apart", () => {
    expect(new Set(Object.values(VERDICT_EXIT_CODES)).size).toBe(Object.keys(VERDICT_EXIT_CODES).length);
    expect(VERDICT_EXIT_CODES.signature_only).not.toBe(0);
  });
});
