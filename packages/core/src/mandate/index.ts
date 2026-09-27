/**
 * `@codespar/sdk/mandate` — offline V3/V4 mandate verification.
 *
 * A third party holding only a presentation token and a raw Ed25519 public key
 * (from the agent's did:web document) can reconstruct the exact signing string
 * and verify the agent + issuer signatures with `node:crypto` alone — no
 * CodeSpar API call. This is the programmatic form of `codespar mandate verify`.
 *
 * Isolation: this lives on its own subpath export so the main SDK client stays
 * free of `node:crypto` (edge/bundler safe). Import it explicitly:
 *
 * ```ts
 * import { verifyMandateToken } from "@codespar/sdk/mandate";
 * const res = verifyMandateToken(token, { agentPublicKey, issuerPublicKey });
 * if (!res.verified) throw new Error("mandate signature invalid");
 * ```
 *
 * The byte format is frozen by the shared `canonical.v3.fixture.json` and
 * `canonical.v4.fixture.json` (the same freezes the enterprise codec and the CLI
 * pin), so all three impls stay in lock step. `node:crypto` is a Node builtin, not an npm dependency — the SDK's
 * zero-runtime-dependency guarantee is intact.
 */
import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";

/**
 * The signed mandate fields. `principal_kyc_ref` and `agent_kid` are absent on
 * V2 and required from V3 on; `issued_at` is required on V4 and absent before.
 */
export interface MandateFields {
  format_version: number;
  id: string;
  agent_id: string;
  type: "payment" | "subscription" | "delegation";
  /** Decimal string without trailing zeros (e.g. "5000", "99.5"). */
  amount: string;
  currency: string;
  /** ASCII-only, sorted lexicographically before encoding. */
  purposes: string[];
  /** UNIX seconds. */
  expires_at: number;
  max_amount?: string | null;
  parent_id?: string | null;
  denomination?: string | null;
  secret_version: number;
  /** V3+. Reference to the proofed CPF/CNPJ (Celcoin KYC) the agent acts for. */
  principal_kyc_ref?: string | null;
  /** V3+. The agent key id (`<agent_did>#<n>`) that signed this mandate. */
  agent_kid?: string | null;
  /** V4-only. Issuance time, UNIX seconds. Signed, so it cannot be moved. */
  issued_at?: number;
}

/** A decoded presentation token: the signed fields plus the signature envelope. */
export interface DecodedMandateToken {
  mandate: MandateFields;
  /** The org-HMAC hex digest. Present on every version; NOT offline-verifiable
   *  (it needs the org secret) — carried through for completeness. */
  signature: string;
  /** V3 envelope: Ed25519 signature by the agent key (base64url). */
  agent_sig?: string;
  /** V3 envelope: Ed25519 signature by the platform issuer key (base64url). */
  issuer_sig?: string;
  /** V3 envelope: the agent key id (`<agent_did>#<n>`) that produced agent_sig. */
  kid?: string;
}

export type MandateDecodeResult =
  | { ok: true; token: DecodedMandateToken }
  | { ok: false; error: "invalid_payload" | "mandate_format_unsupported" };

/**
 * Decode a signed presentation token: base64url UTF-8 JSON of the mandate fields
 * plus `signature` and — for V3 — the `agent_sig` / `issuer_sig` / `kid`
 * envelope. Splits the envelope from the signed fields so `mandate` is exactly
 * the field set the signatures cover. Does not verify anything.
 */
export function decodeMandateToken(token: string): MandateDecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid_payload" };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_payload" };
  }

  const r = raw as Record<string, unknown>;
  const version = r["format_version"];
  // Only the formats whose signing string this module knows. A later format
  // reconstructed with an older tail would fail as "tampered", which is the
  // wrong answer: it is unreadable here, not forged.
  if (typeof version !== "number" || !SUPPORTED_FORMATS.includes(version)) {
    return { ok: false, error: "mandate_format_unsupported" };
  }
  if (!isValidMandateFields(r)) {
    return { ok: false, error: "invalid_payload" };
  }

  const { signature, agent_sig, issuer_sig, kid, ...fields } = r as unknown as MandateFields & {
    signature: unknown;
    agent_sig?: unknown;
    issuer_sig?: unknown;
    kid?: unknown;
  };
  if (typeof signature !== "string") {
    return { ok: false, error: "invalid_payload" };
  }

  const decoded: DecodedMandateToken = { mandate: fields as MandateFields, signature };
  if (typeof agent_sig === "string") decoded.agent_sig = agent_sig;
  if (typeof issuer_sig === "string") decoded.issuer_sig = issuer_sig;
  if (typeof kid === "string") decoded.kid = kid;
  return { ok: true, token: decoded };
}

const SUPPORTED_FORMATS: readonly number[] = [2, 3, 4];

function isValidMandateFields(r: Record<string, unknown>): boolean {
  if (typeof r["format_version"] !== "number") return false;
  if (typeof r["id"] !== "string") return false;
  if (typeof r["agent_id"] !== "string") return false;
  if (!["payment", "subscription", "delegation"].includes(r["type"] as string)) return false;
  if (typeof r["amount"] !== "string") return false;
  if (typeof r["currency"] !== "string") return false;
  if (!Array.isArray(r["purposes"])) return false;
  if (typeof r["expires_at"] !== "number") return false;
  if (typeof r["secret_version"] !== "number") return false;
  if (r["format_version"] === 3 || r["format_version"] === 4) {
    if (typeof r["principal_kyc_ref"] !== "string") return false;
    if (typeof r["agent_kid"] !== "string") return false;
  }
  if (r["format_version"] === 4) {
    if (typeof r["issued_at"] !== "number" || !Number.isInteger(r["issued_at"])) return false;
  }
  return true;
}

/**
 * Reconstruct the canonical signing string the Ed25519 signatures cover.
 *
 * Field order: V2 = 12 fields; V3 = V2 + principal_kyc_ref + agent_kid (14);
 * V4 = V3 with issued_at inserted before agent_kid (15), so agent_kid stays the
 * last field. Absent optionals render empty so the separator count is
 * invariant. `purposes` is comma-joined after a lexicographic sort with
 * escaping (`\` → `\\` first, then `,` → `\,`). Colons inside `agent_kid` (from
 * `did:web`) are emitted verbatim — the string is a one-way serialization,
 * never re-split.
 */
export function reconstructSigningString(f: Record<string, unknown>): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
  const purposes = ((f["purposes"] as string[]) ?? [])
    .slice()
    .sort()
    .map(esc)
    .join(",");
  const version = Number(f["format_version"]);
  const parts: unknown[] = [
    String(f["format_version"]),
    f["id"],
    f["agent_id"],
    f["type"],
    f["amount"],
    f["currency"],
    purposes,
    String(f["expires_at"]),
    f["max_amount"] ?? "",
    f["parent_id"] ?? "",
    f["denomination"] ?? "",
    String(f["secret_version"]),
  ];
  if (version >= 3) parts.push(f["principal_kyc_ref"] ?? "");
  if (version >= 4) parts.push(f["issued_at"] == null ? "" : String(f["issued_at"]));
  if (version >= 3) parts.push(f["agent_kid"] ?? "");
  return parts.join(":");
}

// A raw Ed25519 public key becomes an SPKI KeyObject by prefixing the fixed
// RFC 8410 header. This is the exact wrapper a bare third-party verifier uses.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromRaw(pub: Buffer): KeyObject {
  if (pub.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${pub.length}`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pub]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify an Ed25519 signature (base64url) over a signing string with only the
 * raw 32-byte public key. Returns false — never throws — on malformed input.
 */
export function verifyEd25519(
  signingString: string,
  signatureB64url: string,
  pub: Buffer,
): boolean {
  try {
    return nodeVerify(
      null,
      Buffer.from(signingString, "utf8"),
      publicKeyFromRaw(pub),
      Buffer.from(signatureB64url, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Coerce a hex string (with/without 0x) or raw bytes into a 32-byte key, or null. */
function toPubkey(key: string | Uint8Array | undefined): Buffer | null {
  if (key === undefined) return null;
  if (typeof key === "string") {
    const clean = key.trim().toLowerCase().replace(/^0x/, "");
    if (clean.length !== 64 || !/^[0-9a-f]+$/.test(clean)) return null;
    return Buffer.from(clean, "hex");
  }
  const buf = Buffer.from(key);
  return buf.length === 32 ? buf : null;
}

/** Strip the `#<fragment>` from an agent key id to recover the bare agent DID. */
export function agentDidFromKid(kid: string): string {
  const hash = kid.indexOf("#");
  return hash === -1 ? kid : kid.slice(0, hash);
}

/**
 * Per-signature outcome. `skipped` = carried but no key supplied to check it;
 * `absent` = the token does not carry it. Neither is a pass.
 */
export type SignatureStatus = "verified" | "failed" | "skipped" | "absent";

export interface SignatureCheck {
  present: boolean;
  status: SignatureStatus;
  /** The key id associated with the signature (agent kid; issuer has none). */
  kid?: string;
}

/**
 * Why a token is not verified. Stable machine codes, in this order:
 *   - `kid_mismatch`: the envelope `kid` differs from the signed `agent_kid`;
 *   - `kid_not_in_document`: the agent DID document has no Ed25519 key under
 *     the kid the token names (no other key is tried);
 *   - `agent_sig_absent` / `issuer_sig_absent`: the token does not carry it;
 *   - `agent_sig_unchecked` / `issuer_sig_unchecked`: carried, no key given;
 *   - `agent_sig_invalid` / `issuer_sig_invalid`: checked and did not verify;
 *   - `expired`: the clock is past `expires_at`.
 */
export type MandateVerificationFailure =
  | "kid_mismatch"
  | "kid_not_in_document"
  | "agent_sig_absent"
  | "agent_sig_unchecked"
  | "agent_sig_invalid"
  | "issuer_sig_absent"
  | "issuer_sig_unchecked"
  | "issuer_sig_invalid"
  | "expired";

export interface VerifyMandateOptions {
  /**
   * Raw 32-byte Ed25519 agent public key — hex string or bytes. Passing a raw
   * key asserts it is the key published under the token's `agent_kid`; to have
   * the verifier pick it, pass `agentDidDocument` instead.
   */
  agentPublicKey?: string | Uint8Array;
  /**
   * The agent's did:web document (parsed JSON). Only the `verificationMethod`
   * whose `id` equals the token's signed `agent_kid` is used: a retired key
   * listed beside it does not verify a token that names another kid.
   * Mutually exclusive with `agentPublicKey`.
   */
  agentDidDocument?: unknown;
  /** Raw 32-byte Ed25519 issuer (platform) public key — hex string or bytes. */
  issuerPublicKey?: string | Uint8Array;
  /** The clock for the expiry check, in UNIX seconds. Default: now. */
  now?: number;
}

export interface MandateVerification {
  /**
   * True iff BOTH Ed25519 signatures are carried and verify, under the key the
   * token names, and the token is not expired. Nothing unchecked counts.
   */
  verified: boolean;
  /** Why `verified` is false; empty exactly when it is true. */
  failures: MandateVerificationFailure[];
  /** The clock was past `expires_at`. */
  expired: boolean;
  mandate: MandateFields;
  /** The bare agent DID (kid without its `#fragment`), when present. */
  agentDid?: string;
  /** The agent key id the token names: the signed `agent_kid` (V3+), else the envelope `kid`. */
  kid?: string;
  /** V4: the signed issuance time, UNIX seconds. */
  issuedAt?: number;
  agent: SignatureCheck;
  issuer: SignatureCheck;
}

/**
 * Offline-verify a V3 or V4 mandate presentation token against supplied keys.
 *
 * Pure and network-free: you pass the issuer public key and the agent's public
 * key (or its DID document) and it checks both signatures. `verified` is true
 * only when both signatures are carried and verify, the agent signature under
 * the key the token names, and the token has not expired. A V2 token carries
 * no Ed25519 signature and is never verified here (its only proof is the org
 * HMAC, which needs the org secret).
 *
 * Throws on a token that cannot be decoded (so a caller can distinguish a
 * malformed token from a well-formed but unverified one), and when both
 * `agentPublicKey` and `agentDidDocument` are given.
 */
export function verifyMandateToken(
  token: string,
  opts: VerifyMandateOptions = {},
): MandateVerification {
  if (opts.agentPublicKey !== undefined && opts.agentDidDocument !== undefined) {
    throw new TypeError("pass agentPublicKey or agentDidDocument, not both");
  }
  const decoded = decodeMandateToken(token);
  if (!decoded.ok) {
    throw new Error(`cannot decode mandate token: ${decoded.error}`);
  }
  const t = decoded.token;
  const m = t.mandate;
  const signingString = reconstructSigningString(m as unknown as Record<string, unknown>);
  const failures: MandateVerificationFailure[] = [];

  // The signed agent_kid names the key; the envelope kid is an unsigned copy
  // and may not rename it.
  const signedKid = typeof m.agent_kid === "string" ? m.agent_kid : undefined;
  const kid = signedKid ?? t.kid;
  const kidMismatch = signedKid !== undefined && t.kid !== undefined && t.kid !== signedKid;
  const agentDid = kid ? agentDidFromKid(kid) : undefined;

  let agentKey: Buffer | null;
  let kidMissing = false;
  if (opts.agentDidDocument !== undefined) {
    agentKey = kid ? keyForKid(opts.agentDidDocument, kid) : null;
    kidMissing = agentKey === null;
  } else {
    agentKey = toPubkey(opts.agentPublicKey);
  }

  let agent: SignatureCheck;
  if (kidMismatch) {
    failures.push("kid_mismatch");
    agent = { present: Boolean(t.agent_sig), status: "failed", ...(kid ? { kid } : {}) };
  } else if (kidMissing && t.agent_sig) {
    failures.push("kid_not_in_document");
    agent = { present: true, status: "failed", ...(kid ? { kid } : {}) };
  } else {
    agent = checkSignature(signingString, t.agent_sig, agentKey, kid);
    if (agent.status !== "verified") failures.push(failureFor("agent", agent.status));
  }
  const issuer = checkSignature(signingString, t.issuer_sig, toPubkey(opts.issuerPublicKey), undefined);
  if (issuer.status !== "verified") failures.push(failureFor("issuer", issuer.status));

  const now = opts.now ?? Date.now() / 1000;
  // The API refuses a mandate only once the clock is past expires_at.
  const expired = now > m.expires_at;
  if (expired) failures.push("expired");

  const result: MandateVerification = {
    verified: failures.length === 0,
    failures,
    expired,
    mandate: m,
    agent,
    issuer,
  };
  if (agentDid) result.agentDid = agentDid;
  if (kid) result.kid = kid;
  if (typeof m.issued_at === "number") result.issuedAt = m.issued_at;
  return result;
}

function failureFor(
  who: "agent" | "issuer",
  status: Exclude<SignatureStatus, "verified">,
): MandateVerificationFailure {
  const suffix = status === "absent" ? "absent" : status === "skipped" ? "unchecked" : "invalid";
  return `${who}_sig_${suffix}` as MandateVerificationFailure;
}

/** The raw Ed25519 key a DID document publishes under exactly `kid`, or null. */
function keyForKid(doc: unknown, kid: string): Buffer | null {
  if (!doc || typeof doc !== "object") return null;
  const methods = (doc as { verificationMethod?: unknown }).verificationMethod;
  if (!Array.isArray(methods)) return null;
  for (const vm of methods as Array<Record<string, unknown> | null>) {
    if (!vm || vm["id"] !== kid) continue;
    const jwk = vm["publicKeyJwk"] as Record<string, unknown> | undefined;
    if (!jwk || jwk["kty"] !== "OKP" || jwk["crv"] !== "Ed25519" || typeof jwk["x"] !== "string") {
      return null;
    }
    const pub = Buffer.from(jwk["x"], "base64url");
    return pub.length === 32 ? pub : null;
  }
  return null;
}

function checkSignature(
  signingString: string,
  sig: string | undefined,
  pub: Buffer | null,
  kid: string | undefined,
): SignatureCheck {
  if (!sig) return { present: false, status: "absent", ...(kid ? { kid } : {}) };
  if (!pub) return { present: true, status: "skipped", ...(kid ? { kid } : {}) };
  const ok = verifyEd25519(signingString, sig, pub);
  return { present: true, status: ok ? "verified" : "failed", ...(kid ? { kid } : {}) };
}
