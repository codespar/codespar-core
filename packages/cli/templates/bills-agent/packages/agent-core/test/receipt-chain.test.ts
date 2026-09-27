/**
 * The chain recomputed from a receipt read (ent#1670): the RFC 8785
 * canonicalization, the published recipe as data, and the digest.
 *
 * Nothing here is checked against the module agreeing with itself. The
 * canonicalization is held to the RFC's own examples; the recipe is the one
 * production served on 2026-09-26 (`fixtures/production-receipt-keys.json`,
 * fetched from `https://api.codespar.dev/.well-known/codespar-receipt-keys.json`;
 * staging served the same recipe that day); and the chains are either a
 * literal the enterprise computed with its own code before ent#1670 existed,
 * or the digest of a link list written out by hand, field by field, the way
 * the enterprise's own seal test writes it. The published recipe carries no
 * worked example of its own, so those two are the external vectors.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, isMaskedPayee, readChainRecipe, readSealedApproval, recomputeChain, sameApprovalHash, type ChainRecipe } from "../src/receipt-chain.js";

const PUBLISHED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "production-receipt-keys.json"), "utf8")) as Record<string, unknown>;

function recipe(document: unknown = PUBLISHED): ChainRecipe {
  const read = readChainRecipe(document);
  if (!read.ok) throw new Error(read.message);
  return read.recipe;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ITEMS = `sha256:${"1".repeat(64)}`;
const BATCH = `sha256:${"2".repeat(64)}`;
const MANDATE_SIG = "a".repeat(64);

/** A v4 read, shaped as `GET /v1/consumers/receipts/{id}` answers it: fields the recipe does not name are there too, and must be ignored. */
function v4Read(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    receipt_id: "rcpt_V1StGXR8Z5jdHi6BmyT0sw",
    state: "paid",
    chain_version: 4,
    mandate: { id: "cm_gWEZO68q", nonce: "nonce-123456789", scope: "food", currency: "BRL", sig: MANDATE_SIG, sig_sha256: sha256(MANDATE_SIG) },
    quote: { seller: "Sushi Yassu", resource: "Combinado 20 pc", price_minor: 9980, payee: "yassu@pix.com.br", session_id: "chk_abc123", sig: "q".repeat(64), at: "2026-06-25T12:00:00.000Z" },
    approval: { items_hash: ITEMS, batch_hash: BATCH },
    payment: {
      rail: "pix",
      provider: "celcoin",
      tx_id: "E1393589202606251200",
      amount_minor: 9980,
      amount_atomic: null,
      amount_authorized: null,
      amount_charged: null,
      amount_refunded: null,
      metering: null,
      attempt_id: "cmexec_nonce-123456789",
      money_moved: true,
      at: "2026-06-25T12:00:05.000Z",
    },
    delivery: null,
    chain: "0".repeat(64),
    receipt_sig: "hmac-not-read-here",
    exceptions: [],
    ...over,
  };
}

describe("RFC 8785", () => {
  it("serializes the RFC's own example (section 3.2.4) byte for byte", () => {
    // The input as JSON text, so the numbers go through a parser exactly as the RFC's do.
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", "literals": [null, true, false]}',
    ) as unknown;
    expect(canonicalize(input)).toBe('{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}');
  });

  it("sorts members by UTF-16 code units, the RFC's sorting example (section 3.2.3)", () => {
    const input = JSON.parse('{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", "\\u00f6": "Latin Small Letter O With Diaeresis"}') as Record<string, string>;
    const order = [...canonicalize(input).matchAll(/"([^"]+)":"([^"]+)"/g)].map((m) => m[2]);
    expect(order).toEqual(["Carriage Return", "One", "Control", "Latin Small Letter O With Diaeresis", "Euro Sign", "Emoji: Grinning Face", "Hebrew Letter Dalet With Dagesh"]);
  });

  it("serializes numbers as the RFC's Appendix B lists them", () => {
    const cases: Array<[string, string]> = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af6", "1e+23"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555555", "333333333.3333333"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];
    for (const [ieee, text] of cases) expect(canonicalize(Buffer.from(ieee, "hex").readDoubleBE(0))).toBe(text);
  });

  it("refuses what is not I-JSON rather than hashing something nobody can reproduce", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/not a JSON number/);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/not a JSON number/);
    expect(() => canonicalize("\ud800")).toThrow(/lone surrogate/);
    expect(() => canonicalize({ ["\udc00"]: 1 })).toThrow(/lone surrogate/);
    expect(() => canonicalize(undefined)).toThrow(/not a JSON value/);
    expect(() => canonicalize({ a: undefined })).toThrow(/not a JSON value/);
    expect(canonicalize("😀")).toBe('"😀"');
  });
});

describe("the published recipe is read as data", () => {
  it("reads the document production serves", () => {
    const r = recipe();
    expect(r.canonicalization).toBe("RFC 8785 (JCS)");
    expect(r.links.map((l) => l.link)).toEqual(["mandate", "quote", "approval", "payment", "delivery"]);
    expect(r.links[0]!.fields_by_version?.["4"]).toContain("sig_sha256");
  });

  it("names a document with no recipe for what it is: a deployment older than ent#1670", () => {
    const { chain_recipe: _r, ...older } = PUBLISHED;
    expect(readChainRecipe(older)).toMatchObject({ ok: false, reason: "recipe_unpublished" });
  });

  it("refuses a recipe it would only half follow", () => {
    const base = PUBLISHED["chain_recipe"] as Record<string, unknown>;
    expect(readChainRecipe({ chain_recipe: { ...base, canonicalization: "sorted keys" } })).toMatchObject({ ok: false, reason: "recipe_unrecognized" });
    expect(readChainRecipe({ chain_recipe: { ...base, digest: "SHA-512" } })).toMatchObject({ ok: false, reason: "recipe_unrecognized" });
    expect(readChainRecipe({ chain_recipe: { ...base, links: [] } })).toMatchObject({ ok: false, reason: "recipe_unrecognized" });
  });
});

describe("the chain, recomputed from the read", () => {
  it("reproduces a chain the enterprise's own code computed before ent#1670 (v2, pinned in its receipt-approval-seal test)", () => {
    const read = {
      chain_version: 2,
      mandate: { id: "cm_gWEZO68q", nonce: "nonce-123456789", scope: "food", currency: "BRL", sig: MANDATE_SIG },
      quote: null,
      payment: { rail: "usdc-onchain", provider: "cdp", tx_id: "0xabc", amount_minor: 1, amount_atomic: "10000", amount_authorized: null, amount_charged: null, amount_refunded: null, metering: null, sandbox: true, attempt_id: "cmexec_nonce-123456789", money_moved: true, at: "2026-06-25T12:00:05.000Z" },
      delivery: null,
    };
    expect(recomputeChain(read, recipe())).toEqual({ ok: true, version: 2, chain: "3519728810c899d3b85de0edd0dad1f9991c1bf659ce98597d099b09400df26b" });
  });

  it("v4 is the digest of {v:4, links:[mandate, quote, approval, payment]} with sig_sha256 in place of the signature", () => {
    const read = v4Read();
    const byHand = sha256(
      canonicalize({
        v: 4,
        links: [
          { id: "cm_gWEZO68q", nonce: "nonce-123456789", scope: "food", currency: "BRL", sig_sha256: sha256(MANDATE_SIG) },
          { seller: "Sushi Yassu", resource: "Combinado 20 pc", price_minor: 9980, payee: "yassu@pix.com.br", session_id: "chk_abc123", sig: "q".repeat(64), at: "2026-06-25T12:00:00.000Z" },
          { items_hash: ITEMS, batch_hash: BATCH },
          { rail: "pix", provider: "celcoin", tx_id: "E1393589202606251200", amount_minor: 9980, attempt_id: "cmexec_nonce-123456789", money_moved: true, at: "2026-06-25T12:00:05.000Z" },
        ],
      }),
    );
    expect(recomputeChain(read, recipe())).toEqual({ ok: true, version: 4, chain: byHand });
  });

  it("a v4 read recomputes without the mandate's signature, which a third party must never be handed", () => {
    const read = v4Read();
    const { sig: _sig, ...mandate } = read["mandate"] as Record<string, unknown>;
    expect(recomputeChain({ ...read, mandate }, recipe())).toEqual(recomputeChain(read, recipe()));
  });

  it("every field it seals changes it: payee, amount, approval, batch, a timestamp", () => {
    const original = recomputeChain(v4Read(), recipe());
    const q = v4Read()["quote"] as Record<string, unknown>;
    const p = v4Read()["payment"] as Record<string, unknown>;
    for (const altered of [
      v4Read({ quote: { ...q, payee: "outra@pix.com.br" } }),
      v4Read({ payment: { ...p, amount_minor: 9981 } }),
      v4Read({ approval: { items_hash: `sha256:${"3".repeat(64)}`, batch_hash: BATCH } }),
      v4Read({ approval: { items_hash: ITEMS, batch_hash: null } }),
      v4Read({ payment: { ...p, at: "2026-06-25T12:00:05Z" } }),
    ]) {
      const r = recomputeChain(altered, recipe());
      expect(r.ok).toBe(true);
      expect(r.ok && original.ok && r.chain !== original.chain).toBe(true);
    }
  });

  it("follows the order the document publishes, not one of its own", () => {
    const base = PUBLISHED["chain_recipe"] as { links: unknown[] };
    const [mandate, quote, approval, payment, delivery] = base.links;
    const reordered = recipe({ chain_recipe: { ...base, links: [mandate, approval, quote, payment, delivery] } });
    const a = recomputeChain(v4Read(), recipe());
    const b = recomputeChain(v4Read(), reordered);
    expect(a.ok && b.ok && a.chain !== b.chain).toBe(true);
  });

  it("answers why it cannot, and never guesses", () => {
    const { sig: _sig, ...v2Mandate } = v4Read()["mandate"] as Record<string, unknown>;
    expect(recomputeChain(v4Read({ chain_version: 2, approval: undefined, mandate: v2Mandate }), recipe())).toMatchObject({ ok: false, reason: "mandate_sig_required", version: 2 });
    expect(recomputeChain(v4Read({ quote: { ...(v4Read()["quote"] as object), payee: "yu***@pix.com.br" } }), recipe())).toMatchObject({ ok: false, reason: "payee_masked" });
    expect(recomputeChain(v4Read({ chain_version: undefined }), recipe())).toMatchObject({ ok: false, reason: "chain_version_missing" });
    expect(recomputeChain(v4Read({ approval: null }), recipe())).toMatchObject({ ok: false, reason: "field_missing" });
    const base = PUBLISHED["chain_recipe"] as { links: Array<Record<string, unknown>> };
    const strange = recipe({ chain_recipe: { ...base, links: base.links.map((l) => (l["link"] === "delivery" ? { ...l, when: "the moon is full" } : l)) } });
    expect(recomputeChain(v4Read(), strange)).toMatchObject({ ok: false, reason: "recipe_unrecognized" });
  });
});

describe("the approval link", () => {
  it("is read off the receipt, batch_hash null when the spend sent none", () => {
    expect(readSealedApproval(v4Read())).toEqual({ items_hash: ITEMS, batch_hash: BATCH });
    expect(readSealedApproval(v4Read({ approval: { items_hash: ITEMS, batch_hash: null } }))).toEqual({ items_hash: ITEMS, batch_hash: null });
    expect(readSealedApproval(v4Read({ approval: undefined }))).toBeNull();
  });

  it("compares the two spellings of one hash as one hash, and nothing else as equal", () => {
    expect(sameApprovalHash(ITEMS, "1".repeat(64))).toBe(true);
    expect(sameApprovalHash(null, null)).toBe(true);
    expect(sameApprovalHash(ITEMS, BATCH)).toBe(false);
    expect(sameApprovalHash(null, BATCH)).toBe(false);
  });

  it("knows a masked payee when it sees one", () => {
    expect(isMaskedPayee("es***@exemplo.com.br")).toBe(true);
    expect(isMaskedPayee("escola@exemplo.com.br")).toBe(false);
  });
});
