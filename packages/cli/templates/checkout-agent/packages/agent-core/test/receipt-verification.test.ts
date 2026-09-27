/**
 * The wave-5 contract: a party with the receipt JSON and the published key set
 * reaches the right answer, and the wrong answers stay apart from each other.
 *
 * The signatures here are made with stock `node:crypto` and a key generated in
 * the test, never with the module under test: a test that signed with the
 * verifier's own helper would prove the helper agrees with itself. The signed
 * string is written out literally for the same reason — if the enterprise ever
 * changes the shape, this line fails rather than following it.
 *
 * No network: the key set is a document, or a fetcher the test supplies.
 */
import { createPublicKey, generateKeyPairSync, sign as signDetached, verify as nodeVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECEIPT_KEYS_URL,
  RECEIPT_SIGNATURE_DOMAIN,
  VERDICT_EXIT_CODES,
  receiptKeysUrl,
  receiptSigningString,
  verifyReceipt,
  verifyReceiptWithKeys,
  type PublishedReceiptKey,
} from "../src/receipt-verification.js";

const KID = "did:web:id.codespar.dev#1";
const CHAIN = "9f2c4a1b6d0e8f3a5c7b9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f01";
const RECEIPT_ID = "rcpt_V1StGXR8Z5jdHi6BmyT0sw";

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey, x: Buffer.from(raw).toString("base64url") };
}

function publishedKey(x: string, over: Partial<PublishedReceiptKey> = {}): PublishedReceiptKey {
  return { kid: KID, kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", status: "active", ...over };
}

function keySet(...keys: PublishedReceiptKey[]) {
  return { issuer: "did:web:id.codespar.dev", algorithm: "Ed25519", signing_string: `${RECEIPT_SIGNATURE_DOMAIN}:<receipt_id>:<chain>`, keys };
}

function seal(privateKey: KeyObject, receiptId = RECEIPT_ID, chain = CHAIN): string {
  return signDetached(null, Buffer.from(`codespar-receipt:v1:${receiptId}:${chain}`, "utf8"), privateKey).toString("base64url");
}

function receipt(over: Record<string, unknown> = {}) {
  return {
    receipt_id: RECEIPT_ID,
    state: "paid",
    mandate: { id: "mnd_1" },
    payment: { amount_minor: 12345, payee: "es***@exemplo.com.br", attempt_id: "att_1", money_moved: false, sandbox: true, at: "2026-09-24T12:00:00.000Z" },
    chain: CHAIN,
    receipt_sig: "hmac-half-not-read-here",
    receipt_sig_ed25519: null,
    receipt_sig_kid: null,
    ...over,
  };
}

describe("the signed string", () => {
  it("is the enterprise's, byte for byte", () => {
    expect(receiptSigningString(RECEIPT_ID, CHAIN)).toBe(`codespar-receipt:v1:${RECEIPT_ID}:${CHAIN}`);
    expect(RECEIPT_SIGNATURE_DOMAIN).toBe("codespar-receipt:v1");
  });

  it("names the key set of a deployment from its base url", () => {
    expect(receiptKeysUrl("https://api.codespar.dev")).toBe(DEFAULT_RECEIPT_KEYS_URL);
    expect(receiptKeysUrl("https://staging.example/v1/anything")).toBe("https://staging.example/.well-known/codespar-receipt-keys.json");
  });
});

describe("verified", () => {
  it("accepts a receipt CodeSpar sealed, and says which key signed it", () => {
    const { privateKey, x } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("verified");
    expect(report.receipt_id).toBe(RECEIPT_ID);
    expect(report.kid).toBe(KID);
    expect(report.key_status).toBe("active");
    expect(report.signing_string).toBe(`codespar-receipt:v1:${RECEIPT_ID}:${CHAIN}`);
  });

  it("accepts a signature made by a RETIRED key: rotation retires, it does not revoke", () => {
    const { privateKey, x } = keypair();
    const retired = publishedKey(x, { status: "retired", retired_at: "2026-09-01T00:00:00.000Z" });
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), keySet(retired, publishedKey("ignored", { kid: "did:web:id.codespar.dev#2" })));
    expect(report.verdict).toBe("verified");
    expect(report.key_status).toBe("retired");
  });

  it("still verifies the proof bundle's masked copy: the signature covers the id and the chain, not the body", () => {
    const { privateKey, x } = keypair();
    const sealed = receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID });
    const masked = { ...sealed, payment: { ...sealed.payment, payee: "es***@exemplo.com.br" }, raw: undefined };
    expect(verifyReceiptWithKeys(masked, keySet(publishedKey(x))).verdict).toBe("verified");
  });
});

describe("tampered", () => {
  it("refuses a receipt whose chain was changed after it was sealed", () => {
    const { privateKey, x } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID, chain: CHAIN.replace(/^9/, "8") }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("tampered");
    expect(report.reason).toBe("signature_does_not_match");
  });

  it("refuses a signature lifted from another receipt: the id is in the signed string", () => {
    const { privateKey, x } = keypair();
    const other = seal(privateKey, "rcpt_somebodyelsesreceipt", CHAIN);
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: other, receipt_sig_kid: KID }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("tampered");
  });

  it("refuses a signature made by a key that is not the published one, and names the deployment case", () => {
    const { privateKey } = keypair();
    const other = keypair();
    // The shape of the staging-receipt-against-production-keys mistake: both
    // deployments publish a key called `did:web:id.codespar.dev#1` and the two
    // are not the same key, so the message has to offer that reading.
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), keySet(publishedKey(other.x)));
    expect(report.verdict).toBe("tampered");
    expect(report.message).toContain("deployment");
  });

  it("refuses a signature that is not 64 base64url bytes", () => {
    const { x } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: "not-a-signature", receipt_sig_kid: KID }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("tampered");
    expect(report.reason).toBe("signature_malformed");
  });
});

describe("unsigned", () => {
  it("is not a failure: it says the receipt predates the capability, and that the HMAC is unaffected", () => {
    const report = verifyReceiptWithKeys(receipt(), keySet());
    expect(report.verdict).toBe("unsigned");
    expect(report.message).toContain("never will");
    expect(report.message).toContain("HMAC");
    expect(report.kid).toBeNull();
  });

  it("answers the same when the two fields are absent rather than null", () => {
    const { receipt_sig_ed25519: _sig, receipt_sig_kid: _kid, ...older } = receipt();
    expect(verifyReceiptWithKeys(older, keySet()).verdict).toBe("unsigned");
  });

  it("answers without a key set at all, and without fetching one", async () => {
    let fetched = 0;
    const report = await verifyReceipt(receipt(), {
      url: "https://example.invalid/keys.json",
      fetch: async () => {
        fetched += 1;
        return keySet();
      },
    });
    expect(report.verdict).toBe("unsigned");
    expect(fetched).toBe(0);
  });

  it("covers a paid charge, which the API seals nothing for", () => {
    const charge = { receipt_id: "chg_1", kind: "charge", state: "paid", chain: null, receipt_sig: null, receipt_sig_ed25519: null, receipt_sig_kid: null };
    expect(verifyReceiptWithKeys(charge, keySet()).verdict).toBe("unsigned");
  });
});

describe("unknown_key", () => {
  it("refuses to guess when the kid is not published", () => {
    const { privateKey, x } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: "did:web:id.codespar.dev#9" }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("unknown_key");
    expect(report.kid).toBe("did:web:id.codespar.dev#9");
    expect(report.message).toContain("retired keys published");
  });

  it("does not fall back to the only key in the set", () => {
    const { privateKey, x } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: "did:web:other.example#1" }), keySet(publishedKey(x)));
    expect(report.verdict).toBe("unknown_key");
  });
});

describe("unreachable", () => {
  it("is what a failed fetch answers — never `tampered`", async () => {
    const { privateKey } = keypair();
    const report = await verifyReceipt(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), {
      url: "https://example.invalid/keys.json",
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND example.invalid");
      },
    });
    expect(report.verdict).toBe("unreachable");
    expect(report.reason).toBe("fetch_failed");
    expect(report.message).toContain("Nothing is proved and nothing is disproved");
  });

  it("is what a document that is not a key set answers", () => {
    const { privateKey } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), { error: "not found" });
    expect(report.verdict).toBe("unreachable");
    expect(report.reason).toBe("key_document_unreadable");
  });

  it("is what an unusable published key answers: a key we cannot read tells us nothing about the signature", () => {
    const { privateKey } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), keySet(publishedKey("AAAA")));
    expect(report.verdict).toBe("unreachable");
    expect(report.reason).toBe("key_unusable");
  });

  it("fetches the published set and verifies against it when the fetch works", async () => {
    const { privateKey, x } = keypair();
    const seen: string[] = [];
    const report = await verifyReceipt(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID }), {
      fetch: async (url) => {
        seen.push(url);
        return keySet(publishedKey(x));
      },
    });
    expect(seen).toEqual([DEFAULT_RECEIPT_KEYS_URL]);
    expect(report.verdict).toBe("verified");
  });
});

describe("malformed", () => {
  it("does not call an arbitrary JSON file an unsigned receipt", () => {
    const report = verifyReceiptWithKeys({ hello: "world" }, keySet());
    expect(report.verdict).toBe("malformed");
    expect(report.reason).toBe("receipt_id_missing");
  });

  it("refuses a signature whose kid was deleted, instead of reading it as unsigned", () => {
    const { privateKey } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: null }), keySet());
    expect(report.verdict).toBe("malformed");
    expect(report.reason).toBe("kid_missing");
  });

  it("refuses a kid whose signature was deleted", () => {
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_kid: KID }), keySet());
    expect(report.verdict).toBe("malformed");
    expect(report.reason).toBe("signature_missing");
  });

  it("refuses a signed receipt whose chain was deleted: the signed string cannot be rebuilt", () => {
    const { privateKey } = keypair();
    const report = verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: seal(privateKey), receipt_sig_kid: KID, chain: null }), keySet());
    expect(report.verdict).toBe("malformed");
    expect(report.reason).toBe("chain_missing");
  });

  it("refuses a JSON array or a string", () => {
    expect(verifyReceiptWithKeys([], keySet()).verdict).toBe("malformed");
    expect(verifyReceiptWithKeys("rcpt_1", keySet()).verdict).toBe("malformed");
  });
});

describe("the exit codes", () => {
  it("keep every verdict apart, and do not call an unsigned receipt a success", () => {
    expect(VERDICT_EXIT_CODES.verified).toBe(0);
    expect(new Set(Object.values(VERDICT_EXIT_CODES)).size).toBe(Object.keys(VERDICT_EXIT_CODES).length);
    expect(Object.values(VERDICT_EXIT_CODES)).not.toContain(2); // 2 is the usage error every other command uses
  });
});

describe("the check a third party reimplements", () => {
  it("is four lines of node:crypto over the published JWK", () => {
    const { privateKey, x } = keypair();
    const signature = seal(privateKey);
    // Exactly what someone outside CodeSpar writes, with no code of ours.
    const ok = nodeVerify(
      null,
      Buffer.from(`codespar-receipt:v1:${RECEIPT_ID}:${CHAIN}`, "utf8"),
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }),
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
    expect(verifyReceiptWithKeys(receipt({ receipt_sig_ed25519: signature, receipt_sig_kid: KID }), keySet(publishedKey(x))).verdict).toBe("verified");
  });
});

/**
 * The one fixture that is not this test's own: a receipt the CodeSpar sandbox
 * actually sealed (bills-agent, staging, 2026-09-24), as the proof bundle
 * wrote it, and the key set that deployment publishes, as it was served. Every
 * other case here signs with a key the test made, which proves the module is
 * self-consistent; this one proves it agrees with the signer.
 *
 * Offline: both are files. If the API ever changes the signed string, this is
 * the case that fails.
 */
describe("a receipt the sandbox really sealed", () => {
  const dir = join(import.meta.dirname, "fixtures");
  const real = JSON.parse(readFileSync(join(dir, "staging-receipt.json"), "utf8")) as Record<string, unknown>;
  const realKeys = JSON.parse(readFileSync(join(dir, "staging-receipt-keys.json"), "utf8")) as unknown;

  it("verifies against the key set that deployment publishes", () => {
    const report = verifyReceiptWithKeys(real, realKeys, "staging");
    expect(report.verdict).toBe("verified");
    expect(report.kid).toBe("did:web:id.codespar.dev#1");
    expect(report.signing_string).toBe(`codespar-receipt:v1:${real["receipt_id"] as string}:${real["chain"] as string}`);
  });

  it("is refused when one character of the chain changes", () => {
    const chain = real["chain"] as string;
    const edited = { ...real, chain: chain.slice(0, -1) + (chain.endsWith("0") ? "1" : "0") };
    expect(verifyReceiptWithKeys(edited, realKeys, "staging").verdict).toBe("tampered");
  });

  it("is refused when the receipt id changes, which is why the id is in the signed string", () => {
    expect(verifyReceiptWithKeys({ ...real, receipt_id: "rcpt_0000000000000000000000" }, realKeys, "staging").verdict).toBe("tampered");
  });
});
