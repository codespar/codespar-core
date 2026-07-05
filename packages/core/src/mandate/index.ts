/**
 * `@codespar/sdk/mandate` — offline V3 mandate verification.
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
 * The byte format is frozen by the shared `canonical.v3.fixture.json` (the same
 * freeze the enterprise codec and the CLI pin), so all three impls stay in lock
 * step. `node:crypto` is a Node builtin, not an npm dependency — the SDK's
 * zero-runtime-dependency guarantee is intact.
 */
import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";

/**
 * The signed mandate fields. The two V3-only fields (`principal_kyc_ref`,
 * `agent_kid`) are absent on V2 mandates and required on V3.
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
  /** V3-only. Reference to the proofed CPF/CNPJ (Celcoin KYC) the agent acts for. */
  principal_kyc_ref?: string | null;
  /** V3-only. The agent key id (`<agent_did>#<n>`) that signed this mandate. */
  agent_kid?: string | null;
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
  if (typeof version !== "number" || !Number.isInteger(version) || version < 2) {
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
  if (r["format_version"] === 3) {
    if (typeof r["principal_kyc_ref"] !== "string") return false;
    if (typeof r["agent_kid"] !== "string") return false;
  }
  return true;
}

/**
 * Reconstruct the canonical signing string the Ed25519 signatures cover.
 *
 * Field order (V3 = 14 fields, 13 `:` separators): V2's 12 fields then the two
 * V3-only fields (principal_kyc_ref, agent_kid). Absent optionals render empty
 * so the separator count is invariant. `purposes` is comma-joined after a
 * lexicographic sort with escaping (`\` → `\\` first, then `,` → `\,`). Colons
 * inside `agent_kid` (from `did:web`) are emitted verbatim — the string is a
 * one-way serialization, never re-split. The V3 tail is appended only for
 * `format_version >= 3`, so a V2 mandate reconstructs to its 12-field form.
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
  if (version >= 3) {
    parts.push(f["principal_kyc_ref"] ?? "", f["agent_kid"] ?? "");
  }
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

/** Per-signature outcome. `skipped` = present but no key supplied to check it. */
export type SignatureStatus = "verified" | "failed" | "skipped" | "absent";

export interface SignatureCheck {
  present: boolean;
  status: SignatureStatus;
  /** The key id associated with the signature (agent kid; issuer has none). */
  kid?: string;
}

export interface VerifyMandateOptions {
  /** Raw 32-byte Ed25519 agent public key — hex string or bytes. */
  agentPublicKey?: string | Uint8Array;
  /** Raw 32-byte Ed25519 issuer (platform) public key — hex string or bytes. */
  issuerPublicKey?: string | Uint8Array;
}

export interface MandateVerification {
  /** True iff at least one carried signature verified and none failed. */
  verified: boolean;
  mandate: MandateFields;
  /** The bare agent DID (kid without its `#fragment`), when present. */
  agentDid?: string;
  /** The agent key id from the envelope, when present. */
  kid?: string;
  agent: SignatureCheck;
  issuer: SignatureCheck;
}

/**
 * Offline-verify a V3 mandate presentation token against supplied public keys.
 *
 * Pure and network-free: you pass the agent and/or issuer public keys (from
 * their did:web documents) and it checks the signatures the token carries. A
 * signature with a supplied key that validates is `verified`; a supplied key
 * that fails is `failed`; a carried signature with no supplied key is `skipped`;
 * a signature the token doesn't carry is `absent`. `verified` is true iff at
 * least one signature verified and none failed.
 *
 * Throws only on a token that cannot be decoded (so a caller can distinguish a
 * malformed token from a well-formed but unverified one).
 */
export function verifyMandateToken(
  token: string,
  opts: VerifyMandateOptions = {},
): MandateVerification {
  const decoded = decodeMandateToken(token);
  if (!decoded.ok) {
    throw new Error(`cannot decode mandate token: ${decoded.error}`);
  }
  const t = decoded.token;
  const m = t.mandate;
  const signingString = reconstructSigningString(m as unknown as Record<string, unknown>);

  const kid = t.kid ?? m.agent_kid ?? undefined;
  const agentDid = kid ? agentDidFromKid(kid) : undefined;

  const agent = checkSignature(signingString, t.agent_sig, toPubkey(opts.agentPublicKey), kid);
  const issuer = checkSignature(signingString, t.issuer_sig, toPubkey(opts.issuerPublicKey), undefined);

  const anyVerified = agent.status === "verified" || issuer.status === "verified";
  const anyFailed = agent.status === "failed" || issuer.status === "failed";

  const result: MandateVerification = {
    verified: anyVerified && !anyFailed,
    mandate: m,
    agent,
    issuer,
  };
  if (agentDid) result.agentDid = agentDid;
  if (kid) result.kid = kid;
  return result;
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
