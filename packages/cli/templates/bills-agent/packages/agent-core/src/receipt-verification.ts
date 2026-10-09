/**
 * `receipt-verification`: the half of a receipt a party OUTSIDE CodeSpar can
 * check.
 *
 * A receipt carries two signatures and they prove different things to
 * different people.
 *
 *   `receipt_sig`          HMAC over the chain, under the consumer's secret.
 *                          Verifying it means holding the key that also MINTS
 *                          it, so it proves the payment to whoever runs the
 *                          agent and to nobody else.
 *   `receipt_sig_ed25519`  Ed25519 over `codespar-receipt:v1:<id>:<chain>`,
 *                          made with CodeSpar's platform issuer key, whose
 *                          PUBLIC half is served with no credential at
 *                          `/.well-known/codespar-receipt-keys.json`. That one
 *                          proves the payment to an accountant, a marketplace
 *                          reconciling a payout, or a court — parties that
 *                          have no relationship with CodeSpar at all.
 *
 * This module checks the second. It imports `node:crypto` and two modules of
 * this package that import nothing else (`receipt-chain`, `hash`): no
 * CodeSpar SDK, no key material, no token, no network of its own (the key
 * document is passed in, or fetched by a function the caller supplies). A
 * third party can read the forty lines that matter and reimplement them.
 *
 * TWO LAYERS, and a verdict says which one it reached. The signature proves
 * CodeSpar sealed a receipt with THIS id and THIS chain; `verifyReceiptWithKeys`
 * checks that and nothing else, which is why it survives the proof bundle's
 * masking — the bundle masks the payee, and the signature covers the id and
 * the digest, not the copy in front of you. The chain is a SHA-256 over the
 * links of the Control Record, and since ent#1670 CodeSpar publishes how to
 * recompute it (`chain_recipe`, beside the keys). `verifyReceiptRead` does:
 * from the API's receipt READ, under the recipe of the SAME document whose
 * key verified the signature, it recomputes the chain and holds it against
 * the signed one — and for a v4 chain, holds the sealed approval link against
 * the local approval artifact. `verified` from it means all of that held;
 * `signature_only` means the signature held and the body could not be bound
 * (a v1–v3 chain, a masked payee, no recipe), which is not a failure and is
 * not a verification of the body either. See `docs/OPEN_QUESTIONS.md` §47.
 *
 * WHICH KEY SET. The verifier points at ONE deployment's
 * `/.well-known/codespar-receipt-keys.json` — the default is production, and
 * `--url` names another. Since ent#1641 a deployment names its keys by
 * namespace (`#production-2`, `#staging-2`), so a receipt checked against the
 * wrong set finds no key of its name (`unknown_key`); the retired `#1` is
 * still published by both with different keys, and a receipt sealed under it
 * checked against the wrong set reads `tampered`. `docs/OPEN_QUESTIONS.md` §47.
 *
 * The signed string is the enterprise's `receiptSigningString`
 * (`packages/api/src/receipt-signature.ts`, ent#1633), reproduced here rather
 * than imported, because a verifier that has to install the signer's code
 * proves nothing about the signer.
 */
import { createPublicKey, verify as verifyDetached } from "node:crypto";
import { itemsHash } from "./hash.js";
import { readChainRecipe, readSealedApproval, recomputeChain, sameApprovalHash, type ChainRecipe, type SealedApproval } from "./receipt-chain.js";
import type { ExecutionItem } from "./types.js";

/** The domain tag. A receipt names the version it was sealed under through
 *  this literal, so a future `v2` does not invalidate a `v1` signature. */
export const RECEIPT_SIGNATURE_DOMAIN = "codespar-receipt:v1";

/** The unauthenticated key set of the production API. `--url` points the
 *  verifier at another deployment (staging), `--keys` at a file. */
export const DEFAULT_RECEIPT_KEYS_URL = "https://api.codespar.dev/.well-known/codespar-receipt-keys.json";

/** The key set of a deployment, from its base URL. */
export function receiptKeysUrl(baseUrl: string): string {
  return new URL("/.well-known/codespar-receipt-keys.json", baseUrl).toString();
}

/** The exact bytes the Ed25519 signature covers. Every segment is fixed-shape:
 *  the domain is a literal, the id is `rcpt_` + 22 url-safe characters, and the
 *  chain is 64 hex. No free text reaches this string. */
export function receiptSigningString(receiptId: string, chain: string): string {
  return `${RECEIPT_SIGNATURE_DOMAIN}:${receiptId}:${chain}`;
}

/**
 * The six honest answers. Five of them are not "invalid", and keeping them
 * apart is the point of the module:
 *
 *   `verified`     the signature is CodeSpar's, over this id and this chain.
 *   `tampered`     a signature is there and it does not match. A refusal.
 *   `unsigned`     no signature on this copy. NOT a failure: every receipt
 *                  sealed before CodeSpar added Ed25519 has none and never
 *                  will, because signing them today with today's key would
 *                  attest to what the database says now, not to what happened.
 *   `unknown_key`  the `kid` is not in the key set. Retired keys stay
 *                  published precisely so old signatures keep verifying, so a
 *                  missing kid means another deployment, or a revoked key.
 *   `unreachable`  no usable key set. UNKNOWN — never "invalid".
 *   `malformed`    the file is not a receipt this module can read. Distinct
 *                  from `unsigned` on purpose: answering "unsigned" for an
 *                  arbitrary JSON file would state that it is a receipt from
 *                  before the capability existed, which is a claim about a
 *                  file nobody checked.
 *
 * And three that only the body check (`verifyReceiptRead`) reaches, each
 * after the signature verified:
 *
 *   `signature_only`     the body could not be bound to the chain: a v1–v3
 *                        chain, a masked payee, no read, no recipe. NOT a
 *                        failure, and NOT `verified`: the signature is
 *                        CodeSpar's, and nothing here says the body beside it
 *                        is the body it sealed.
 *   `chain_mismatch`     the body, recomputed under the published recipe, is
 *                        NOT the signed chain. The signature is genuine and
 *                        the body in front of you is not the one it covers.
 *   `approval_mismatch`  the body is the signed one, and the approval link it
 *                        seals is NOT the local artifact's: this payment was
 *                        not sealed against the list that artifact approved.
 */
export type ReceiptVerdict = "verified" | "tampered" | "unsigned" | "unknown_key" | "unreachable" | "malformed" | "signature_only" | "chain_mismatch" | "approval_mismatch";

/** What recomputing the chain from the body found. */
export interface ChainCheck {
  /** `recomputed`: equal to the signed chain. `mismatch`: not equal. `not_recomputed`: see `reason`. */
  status: "recomputed" | "mismatch" | "not_recomputed";
  version: number | null;
  /** The digest recomputed from the body, when it could be. */
  recomputed: string | null;
  reason: string;
}

/**
 * Whether the sealed payment was a sandbox one and whether money moved, read off a body that recomputed to the signed chain. A field
 * is `null` when the recipe's payment link for that version does not seal it: a value the chain does not cover is not reported as one
 * it does. Only these two, so a verdict never carries the rest of the read (the tenant's read also carries `mandate.sig`).
 */
export interface SealedPayment {
  sandbox: boolean | null;
  money_moved: boolean | null;
}

/** What the sealed approval link was held against. Present on a v4 chain that recomputed. */
export interface ApprovalLinkCheck {
  /** `matched`: the artifact's hashes are the sealed ones. `mismatch`: they are not. `not_compared`: no artifact was given. */
  status: "matched" | "mismatch" | "not_compared";
  sealed: SealedApproval;
  artifact: { approval_id: string; items_hash: string; batch_hash: string | null } | null;
  reason: string;
}

/** The part of an approval artifact the approval link is held against: what was approved, never who. */
export interface ApprovalClaim {
  approval_id: string;
  items_hash: string;
  /** When present, `items_hash` is recomputed from them first: a hash that does not describe its own list proves nothing about the list. */
  items?: readonly ExecutionItem[];
  batch?: { batch_hash: string };
}

export interface ReceiptVerification {
  verdict: ReceiptVerdict;
  /** The receipt this is about, when the document names one. */
  receipt_id: string | null;
  /** The key the receipt names, when it names one. */
  kid: string | null;
  /** `active` or `retired`, as the key set publishes it. A retired key signs
   *  nothing new and verifies everything it already signed. */
  key_status: string | null;
  /** The bytes that were verified, so a reader can reproduce the check by hand. */
  signing_string: string | null;
  /** Where the keys came from, or `null` when no key was needed. */
  keys_from: string | null;
  /** A stable machine code under the verdict. */
  reason: string;
  /** One sentence for a person. Never a stack trace. */
  message: string;
  /** The body check, when one was attempted: only `verifyReceiptRead` attempts it, and only on a signature that verified. */
  chain_check?: ChainCheck;
  approval_check?: ApprovalLinkCheck;
  /** Present exactly when the body recomputed to the signed chain. */
  sealed_payment?: SealedPayment;
}

/** One published key, RFC 8037 shape, as the JWKS serves it. */
export interface PublishedReceiptKey {
  kid: string;
  kty: string;
  crv: string;
  /** base64url of the raw 32-byte public key. */
  x: string;
  alg?: string;
  use?: string;
  status?: string;
  created_at?: string;
  retired_at?: string | null;
}

export interface ReceiptKeyDocument {
  issuer?: string;
  algorithm?: string;
  signing_string?: string;
  keys: PublishedReceiptKey[];
}

/** The receipt fields this module reads. Everything else in the JSON is none
 *  of its business — including the HMAC seal, which needs a secret it must
 *  never be given. */
export interface SignedReceiptFields {
  receipt_id: string;
  chain: string | null;
  receipt_sig_ed25519: string | null;
  receipt_sig_kid: string | null;
}

/** The caller's fetcher. Injected so the module has no network of its own and
 *  a unit test needs none. */
export type KeyDocumentFetcher = (url: string) => Promise<unknown>;

export interface KeySource {
  /** A key set already in hand — a file, a fixture, a document fetched once
   *  and reused across a folder of receipts. */
  document?: unknown;
  /** Where to fetch it from, with the function that does the fetching. */
  url?: string;
  fetch?: KeyDocumentFetcher;
  /** What to call the origin in the report. Defaults to the url, or `file`. */
  label?: string;
}

/* ── Reading the documents ───────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** base64url, strictly: Node's decoder accepts standard base64 and skips
 *  characters it does not know, so a round trip is what proves the string was
 *  the encoding it claims to be. */
function decodeBase64Url(value: string, expectedBytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== expectedBytes || buf.toString("base64url") !== value) return undefined;
  return buf;
}

export type ReceiptRead = { ok: true; fields: SignedReceiptFields } | { ok: false; reason: string; message: string; receipt_id: string | null };

/**
 * Read the four fields out of a receipt JSON, or say why it cannot be read.
 *
 * A signature without its `kid`, or a `kid` without its signature, is a
 * MALFORMED document and not an unsigned one. The API writes both columns or
 * neither, so half a pair means the file was edited — and "unsigned" is the
 * benign verdict, which is exactly the one an edit must not be able to reach
 * by deletion.
 */
export function readSignedReceipt(input: unknown): ReceiptRead {
  if (!isRecord(input)) {
    return { ok: false, reason: "not_an_object", receipt_id: null, message: "this file is not a JSON object, so it is not a receipt" };
  }
  const receiptId = stringOrNull(input["receipt_id"]);
  if (receiptId === null) {
    return { ok: false, reason: "receipt_id_missing", receipt_id: null, message: "this JSON carries no `receipt_id`, so it is not a CodeSpar receipt" };
  }
  const sigRaw = input["receipt_sig_ed25519"];
  const kidRaw = input["receipt_sig_kid"];
  const sig = stringOrNull(sigRaw);
  const kid = stringOrNull(kidRaw);
  const sigAbsent = sigRaw === undefined || sigRaw === null;
  const kidAbsent = kidRaw === undefined || kidRaw === null;
  if (!sigAbsent && sig === null) {
    return { ok: false, reason: "signature_not_a_string", receipt_id: receiptId, message: `receipt ${receiptId} carries a \`receipt_sig_ed25519\` that is not a string` };
  }
  if (!kidAbsent && kid === null) {
    return { ok: false, reason: "kid_not_a_string", receipt_id: receiptId, message: `receipt ${receiptId} carries a \`receipt_sig_kid\` that is not a string` };
  }
  if (sig !== null && kid === null) {
    return { ok: false, reason: "kid_missing", receipt_id: receiptId, message: `receipt ${receiptId} carries a signature and no \`receipt_sig_kid\`, so there is no way to know which key to check it against; a receipt sealed before Ed25519 carries neither` };
  }
  if (kid !== null && sig === null) {
    return { ok: false, reason: "signature_missing", receipt_id: receiptId, message: `receipt ${receiptId} names the key \`${kid}\` and carries no \`receipt_sig_ed25519\` to check against it` };
  }
  const chain = stringOrNull(input["chain"]);
  if (sig !== null && chain === null) {
    return { ok: false, reason: "chain_missing", receipt_id: receiptId, message: `receipt ${receiptId} carries a signature and no \`chain\`, so the signed string cannot be rebuilt` };
  }
  return { ok: true, fields: { receipt_id: receiptId, chain, receipt_sig_ed25519: sig, receipt_sig_kid: kid } };
}

export type KeyDocumentRead = { ok: true; document: ReceiptKeyDocument } | { ok: false; reason: string; message: string };

/** Read a JWKS, or say why it is not one. Anything unusable is `unreachable`
 *  territory: a key set we cannot read leaves us knowing nothing about the
 *  signature, which is not the same as knowing it is bad. */
export function readKeyDocument(input: unknown): KeyDocumentRead {
  if (!isRecord(input)) return { ok: false, reason: "key_document_unreadable", message: "the key set is not a JSON object" };
  const keys = input["keys"];
  if (!Array.isArray(keys)) return { ok: false, reason: "key_document_unreadable", message: "the key set carries no `keys` array" };
  const parsed: PublishedReceiptKey[] = [];
  for (const entry of keys) {
    if (!isRecord(entry)) continue;
    const kid = stringOrNull(entry["kid"]);
    const x = stringOrNull(entry["x"]);
    const kty = stringOrNull(entry["kty"]);
    const crv = stringOrNull(entry["crv"]);
    if (kid === null || x === null || kty === null || crv === null) continue;
    parsed.push({
      kid,
      kty,
      crv,
      x,
      ...(stringOrNull(entry["alg"]) !== null ? { alg: entry["alg"] as string } : {}),
      ...(stringOrNull(entry["status"]) !== null ? { status: entry["status"] as string } : {}),
    });
  }
  const document: ReceiptKeyDocument = {
    keys: parsed,
    ...(stringOrNull(input["issuer"]) !== null ? { issuer: input["issuer"] as string } : {}),
    ...(stringOrNull(input["signing_string"]) !== null ? { signing_string: input["signing_string"] as string } : {}),
  };
  return { ok: true, document };
}

/* ── The check ───────────────────────────────────────────────── */

/**
 * Verify a receipt against a key set already in hand. Synchronous, offline,
 * and the whole of the cryptography: everything else in this file is reading
 * JSON carefully.
 */
export function verifyReceiptWithKeys(receipt: unknown, keyDocument: unknown, label = "file"): ReceiptVerification {
  const read = readSignedReceipt(receipt);
  if (!read.ok) {
    return { verdict: "malformed", receipt_id: read.receipt_id, kid: null, key_status: null, signing_string: null, keys_from: null, reason: read.reason, message: read.message };
  }
  const { receipt_id: receiptId, chain, receipt_sig_ed25519: signature, receipt_sig_kid: kid } = read.fields;

  if (signature === null || kid === null || chain === null) {
    return {
      verdict: "unsigned",
      receipt_id: receiptId,
      kid: null,
      key_status: null,
      signing_string: null,
      keys_from: null,
      reason: "no_ed25519_signature",
      message: `receipt ${receiptId} carries no Ed25519 signature. Receipts sealed before CodeSpar added one carry none and never will; its HMAC seal is unaffected and still proves the payment to whoever runs the agent`,
    };
  }

  const signingString = receiptSigningString(receiptId, chain);
  const doc = readKeyDocument(keyDocument);
  if (!doc.ok) {
    return { verdict: "unreachable", receipt_id: receiptId, kid, key_status: null, signing_string: signingString, keys_from: label, reason: doc.reason, message: `${doc.message}, so nothing is proved and nothing is disproved about receipt ${receiptId}` };
  }

  const key = doc.document.keys.find((k) => k.kid === kid);
  if (!key) {
    return {
      verdict: "unknown_key",
      receipt_id: receiptId,
      kid,
      key_status: null,
      signing_string: signingString,
      keys_from: label,
      reason: "kid_not_published",
      message: `the key \`${kid}\` is not among the ${doc.document.keys.length} published at ${label}. CodeSpar keeps retired keys published so old signatures go on verifying, so a missing kid is a key from another deployment, or one that was revoked`,
    };
  }
  const keyStatus = key.status ?? null;

  if (key.kty !== "OKP" || key.crv !== "Ed25519") {
    return { verdict: "unreachable", receipt_id: receiptId, kid, key_status: keyStatus, signing_string: signingString, keys_from: label, reason: "key_unusable", message: `the published key \`${kid}\` is ${key.kty}/${key.crv} and not OKP/Ed25519, so this module cannot check the signature with it` };
  }
  const publicKey = decodeBase64Url(key.x, 32);
  if (!publicKey) {
    return { verdict: "unreachable", receipt_id: receiptId, kid, key_status: keyStatus, signing_string: signingString, keys_from: label, reason: "key_unusable", message: `the published key \`${kid}\` does not carry a 32-byte base64url public key, so this module cannot check the signature with it` };
  }
  const signatureBytes = decodeBase64Url(signature, 64);
  if (!signatureBytes) {
    return { verdict: "tampered", receipt_id: receiptId, kid, key_status: keyStatus, signing_string: signingString, keys_from: label, reason: "signature_malformed", message: `receipt ${receiptId} carries a \`receipt_sig_ed25519\` that is not a 64-byte base64url Ed25519 signature, so it is not the one CodeSpar wrote` };
  }

  let matches: boolean;
  try {
    matches = verifyDetached(null, Buffer.from(signingString, "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), signatureBytes);
  } catch (err) {
    return { verdict: "unreachable", receipt_id: receiptId, kid, key_status: keyStatus, signing_string: signingString, keys_from: label, reason: "key_unusable", message: `the published key \`${kid}\` could not be used: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!matches) {
    return {
      verdict: "tampered",
      receipt_id: receiptId,
      kid,
      key_status: keyStatus,
      signing_string: signingString,
      keys_from: label,
      reason: "signature_does_not_match",
      message: `receipt ${receiptId} does not match its signature: the key \`${kid}\` did not sign this receipt id and this chain. The id or the chain was changed after the receipt was sealed, the signature was copied from another receipt, or this key set is not the one the deployment that sealed it publishes — a sandbox receipt checked against the production keys reads exactly like this, because every deployment publishes its own key under the same \`kid\``,
    };
  }
  return {
    verdict: "verified",
    receipt_id: receiptId,
    kid,
    key_status: keyStatus,
    signing_string: signingString,
    keys_from: label,
    reason: "signature_matches",
    message: `receipt ${receiptId} was sealed by CodeSpar: the ${keyStatus ?? "published"} key \`${kid}\` signed this receipt id and this chain`,
  };
}

/**
 * Verify a receipt, fetching the key set when one is not in hand.
 *
 * The fetch is the caller's function, so this module opens no socket and a
 * unit test needs no network. A fetch that fails is `unreachable` and never
 * `tampered`: not knowing is not the same as knowing it is bad, and a
 * verifier that conflated the two would call every receipt invalid the day
 * its DNS broke.
 */
export async function verifyReceipt(receipt: unknown, source: KeySource = {}): Promise<ReceiptVerification> {
  const read = readSignedReceipt(receipt);
  if (!read.ok) {
    return { verdict: "malformed", receipt_id: read.receipt_id, kid: null, key_status: null, signing_string: null, keys_from: null, reason: read.reason, message: read.message };
  }
  // An unsigned receipt needs no key, so it is answered before the network is
  // touched: fetching a key set to check a signature that is not there would
  // turn an offline answer into an outage.
  if (read.fields.receipt_sig_ed25519 === null) return verifyReceiptWithKeys(receipt, { keys: [] }, source.label ?? "none");

  if (source.document !== undefined) return verifyReceiptWithKeys(receipt, source.document, source.label ?? "file");

  const url = source.url ?? DEFAULT_RECEIPT_KEYS_URL;
  const label = source.label ?? url;
  if (!source.fetch) {
    return { verdict: "unreachable", receipt_id: read.fields.receipt_id, kid: read.fields.receipt_sig_kid, key_status: null, signing_string: null, keys_from: label, reason: "no_fetcher", message: "no key set was given and no way to fetch one: pass a document, or a fetch function" };
  }
  let fetched: unknown;
  try {
    fetched = await source.fetch(url);
  } catch (err) {
    return {
      verdict: "unreachable",
      receipt_id: read.fields.receipt_id,
      kid: read.fields.receipt_sig_kid,
      key_status: null,
      signing_string: null,
      keys_from: label,
      reason: "fetch_failed",
      message: `the published key set could not be read from ${label}: ${err instanceof Error ? err.message : String(err)}. Nothing is proved and nothing is disproved; the keys can also be saved to a file and passed in`,
    };
  }
  return verifyReceiptWithKeys(receipt, fetched, label);
}

/** The exit code of `codespar-agent verify`, one per verdict, so a script can
 *  branch on the answer instead of on "did it fail". `unsigned` is not 0: it is
 *  not a failure, and it is not a verification either. 2 is the usage error the
 *  other commands already use. */
export const VERDICT_EXIT_CODES: Record<ReceiptVerdict, number> = {
  verified: 0,
  tampered: 1,
  unsigned: 3,
  unknown_key: 4,
  unreachable: 5,
  malformed: 6,
  signature_only: 7,
  chain_mismatch: 8,
  approval_mismatch: 9,
};

/* ── The body: the chain recomputed from the read ────────────── */

/** The first chain version that seals `sha256(mandate.sig)` instead of the signature, and the approval link. */
export const FIRST_THIRD_PARTY_CHAIN_VERSION = 4;

/** Whether a JSON is the API's receipt read, rather than the proof bundle's masked copy of one: only the read carries the links. */
export function isReceiptRead(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input)) return false;
  const mandate = input["mandate"];
  const payment = input["payment"];
  return isRecord(mandate) && "nonce" in mandate && isRecord(payment) && "rail" in payment;
}

/** A verified signature whose body could not be bound: `signature_only`, with the reason. */
export function signatureOnly(signature: ReceiptVerification, reason: string, why: string, version: number | null = null): ReceiptVerification {
  return {
    ...signature,
    verdict: "signature_only",
    reason,
    message: `receipt ${signature.receipt_id ?? "(no id)"} carries CodeSpar's signature over its id and chain, and its body is NOT bound to that chain: ${why}`,
    chain_check: { status: "not_recomputed", version, recomputed: null, reason },
  };
}

/**
 * Verify a receipt READ — the JSON of `GET /v1/consumers/receipts/{id}` —
 * against a key set already in hand: the signature, then the body, then the
 * approval. Synchronous and offline, like `verifyReceiptWithKeys`.
 *
 * The recipe is taken from the SAME document whose key verified the
 * signature, never from another: each deployment names its keys by
 * namespace (§47), so a document that verified the signature is the sealing
 * deployment's, and its recipe is the one that sealed.
 *
 * A v1–v3 chain is never recomputed here, even from a tenant's read that
 * carries `mandate.sig`: that signature is a bearer proof (it authorizes
 * spends), a verifier has no business handling it, and the API is retiring
 * it from the read. Those chains also predate the API's timestamp fix
 * (ent#1670), so some of them no longer recompute from their read at all —
 * and a mismatch there would accuse a genuine receipt. They answer
 * `signature_only`, never `verified` and never `chain_mismatch`.
 */
export function verifyReceiptRead(read: unknown, keyDocument: unknown, options: { label?: string; approval?: ApprovalClaim } = {}): ReceiptVerification {
  const signature = verifyReceiptWithKeys(read, keyDocument, options.label ?? "file");
  if (signature.verdict !== "verified" || !isRecord(read)) return signature;
  if (!isReceiptRead(read)) return signatureOnly(signature, "read_required", "this is not the API's receipt read (the proof bundle's copy masks the payee and carries none of the links); recompute from `GET /v1/consumers/receipts/{id}`");

  const recipe = readChainRecipe(keyDocument);
  if (!recipe.ok) return signatureOnly(signature, recipe.reason, recipe.message);

  const versionRaw = read[recipe.recipe.version.field];
  if (typeof versionRaw === "number" && versionRaw < FIRST_THIRD_PARTY_CHAIN_VERSION) {
    return signatureOnly(
      signature,
      "mandate_sig_required",
      `the chain is not recomputable without the mandate signature. Chain v${versionRaw} seals the mandate's raw signature, a bearer proof this verifier does not take; and a receipt sealed before ent#1670 may not recompute from its read at all. It carries no approval link either: that starts at v${FIRST_THIRD_PARTY_CHAIN_VERSION}`,
      versionRaw,
    );
  }

  const recomputed = recomputeChain(read, recipe.recipe);
  if (!recomputed.ok) return signatureOnly(signature, recomputed.reason, recomputed.message, recomputed.version);
  const sealedChain = read["chain"];
  if (recomputed.chain !== sealedChain) {
    return {
      ...signature,
      verdict: "chain_mismatch",
      reason: "body_does_not_recompute",
      message: `receipt ${signature.receipt_id} carries a genuine CodeSpar signature over chain ${sealedChain}, and the body beside it recomputes to ${recomputed.chain} under the published recipe (v${recomputed.version}): this body is not the one that was sealed. A payee, an amount, a timestamp or the approval was changed after sealing`,
      chain_check: { status: "mismatch", version: recomputed.version, recomputed: recomputed.chain, reason: "body_does_not_recompute" },
    };
  }
  const chainCheck: ChainCheck = { status: "recomputed", version: recomputed.version, recomputed: recomputed.chain, reason: "body_recomputes" };
  const sealedPayment = sealedPaymentOf(read, recipe.recipe, recomputed.version);
  const bound = `the body recomputes to the signed chain under the published recipe (v${recomputed.version})`;

  const sealed = readSealedApproval(read);
  if (!sealed) {
    // Unreachable through the published recipe (v4 seals the link, and a read without it fails the recomputation above), kept so a future version is not misread.
    return { ...signature, reason: "body_recomputes", message: `receipt ${signature.receipt_id} was sealed by CodeSpar and ${bound}; it seals no approval link`, chain_check: chainCheck, sealed_payment: sealedPayment };
  }
  const approval = options.approval;
  if (!approval) {
    return {
      ...signature,
      reason: "body_recomputes",
      message: `receipt ${signature.receipt_id} was sealed by CodeSpar and ${bound}. It seals the approval ${sealed.items_hash}${sealed.batch_hash ? ` (batch ${sealed.batch_hash})` : ""}; no approval artifact was given to hold it against`,
      chain_check: chainCheck,
      approval_check: { status: "not_compared", sealed, artifact: null, reason: "no_artifact" },
      sealed_payment: sealedPayment,
    };
  }

  const artifact = { approval_id: approval.approval_id, items_hash: approval.items_hash, batch_hash: approval.batch?.batch_hash ?? null };
  const mismatch = (reason: string, why: string): ReceiptVerification => ({
    ...signature,
    verdict: "approval_mismatch",
    reason,
    message: `receipt ${signature.receipt_id} was sealed by CodeSpar and ${bound}, and ${why}: this payment was not sealed against the list artifact ${approval.approval_id} approved`,
    chain_check: chainCheck,
    approval_check: { status: "mismatch", sealed, artifact, reason },
    sealed_payment: sealedPayment,
  });
  if (approval.items && itemsHash(approval.items) !== approval.items_hash) {
    return mismatch("artifact_items_hash_inconsistent", `the artifact's items_hash ${approval.items_hash} is not the hash of the items it lists (${itemsHash(approval.items)})`);
  }
  if (!sameApprovalHash(sealed.items_hash, artifact.items_hash)) {
    return mismatch("items_hash_differs", `it seals items_hash ${sealed.items_hash} where the artifact carries ${artifact.items_hash}`);
  }
  if (!sameApprovalHash(sealed.batch_hash, artifact.batch_hash)) {
    return mismatch("batch_hash_differs", `it seals batch_hash ${sealed.batch_hash ?? "none"} where the artifact carries ${artifact.batch_hash ?? "none"}`);
  }
  return {
    ...signature,
    reason: "approval_matches",
    message: `receipt ${signature.receipt_id} was sealed by CodeSpar, ${bound}, and it was paid against the list artifact ${approval.approval_id} approved (${sealed.items_hash}${sealed.batch_hash ? `, batch ${sealed.batch_hash}` : ""}). WHO approved it is in the artifact, under a local key, and nowhere in the seal`,
    chain_check: chainCheck,
    approval_check: { status: "matched", sealed, artifact, reason: "approval_matches" },
    sealed_payment: sealedPayment,
  };
}

function sealedPaymentOf(read: Record<string, unknown>, recipe: ChainRecipe, version: number): SealedPayment {
  const spec = recipe.links.find((l) => l.from === "payment");
  const fields = spec?.fields ?? spec?.fields_by_version?.[String(version)] ?? [];
  const payment = read["payment"];
  const pick = (name: string): boolean | null => {
    if (!fields.includes(name) && !fields.includes(`${name}${recipe.optional_marker}`)) return null;
    const value = isRecord(payment) ? payment[name] : undefined;
    return typeof value === "boolean" ? value : null;
  };
  return { sandbox: pick("sandbox"), money_moved: pick("money_moved") };
}
