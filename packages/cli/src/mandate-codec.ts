/**
 * Offline V3 mandate verification — a dependency-free port of the canonical
 * signing-string format from `codespar-enterprise/packages/mandate/canonical.ts`.
 *
 * This is the third-party verifier path: given only a presentation token and a
 * raw 32-byte Ed25519 public key (from a did:web document), a counterparty can
 * reconstruct the exact 14-field signing string and verify the agent + issuer
 * signatures with `node:crypto` alone — no CodeSpar API call, no CodeSpar code.
 *
 * PORT, not import: the codec lives in the private enterprise repo. The byte
 * format is frozen by `tests/fixtures/canonical.v3.fixture.json` (copied into
 * this package's tests), so any drift here fails the fixture byte-lock.
 *
 * Zero runtime deps — `node:crypto` and the standard library only, matching the
 * SDK's zero-dependency constraint.
 */
import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";

/**
 * The signed mandate fields. Mirrors the enterprise `MandateFields`. The two
 * V3-only fields (`principal_kyc_ref`, `agent_kid`) are absent on V2 mandates.
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
export interface DecodedToken {
  mandate: MandateFields;
  /** The org-HMAC hex digest — present on every version. Not verifiable offline
   *  (it needs the org secret); carried through for completeness. */
  signature: string;
  /** V3 envelope: Ed25519 signature by the agent key (base64url). */
  agent_sig?: string;
  /** V3 envelope: Ed25519 signature by the platform issuer key (base64url). */
  issuer_sig?: string;
  /** V3 envelope: the agent key id (`<agent_did>#<n>`) that produced agent_sig. */
  kid?: string;
}

export type DecodeResult =
  | { ok: true; token: DecodedToken }
  | { ok: false; error: "invalid_payload" | "mandate_format_unsupported" };

/**
 * Decode a signed token produced by the enterprise `computeToken`: a base64url
 * UTF-8 JSON object carrying all MandateFields plus `signature` (org-HMAC hex)
 * and — for V3 — the `agent_sig` / `issuer_sig` / `kid` envelope members.
 *
 * DOES NOT verify anything; it only splits the envelope from the signed fields
 * so `mandate` is exactly the field set the signatures cover.
 */
export function decodeToken(token: string): DecodeResult {
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

  // Pull the envelope members out so `mandate` is exactly the signed fields.
  const { signature, agent_sig, issuer_sig, kid, ...fields } = r as unknown as MandateFields & {
    signature: unknown;
    agent_sig?: unknown;
    issuer_sig?: unknown;
    kid?: unknown;
  };
  if (typeof signature !== "string") {
    return { ok: false, error: "invalid_payload" };
  }

  const decoded: DecodedToken = { mandate: fields as MandateFields, signature };
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
  // V3 binds the KYC'd principal and the signing key into the signed string,
  // so both are mandatory for a well-formed V3 payload.
  if (r["format_version"] === 3) {
    if (typeof r["principal_kyc_ref"] !== "string") return false;
    if (typeof r["agent_kid"] !== "string") return false;
  }
  return true;
}

/**
 * Reconstruct the canonical signing string the Ed25519 signatures cover.
 *
 * Field order (V3 = 14 fields, 13 `:` separators): V2's 12 fields, then the two
 * V3-only fields appended (principal_kyc_ref, agent_kid). Absent optionals
 * render as the empty string so the separator count is invariant. `purposes` is
 * comma-joined after a lexicographic sort with escaping (`\` → `\\` first, then
 * `,` → `\,`). Colons inside `agent_kid` (from the `did:web` prefix) are emitted
 * verbatim — the signing string is a one-way serialization, never re-split.
 *
 * A V2 mandate reconstructs to 12 fields because its two V3 fields are absent
 * (rendered empty would change the byte count), so this reads the fields it
 * needs and appends the V3 tail only when `format_version >= 3`.
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

// ── Ed25519 verify with only a raw 32-byte public key ─────────────────
//
// A raw Ed25519 public key becomes an SPKI KeyObject by prefixing the fixed
// RFC 8410 header (302a300506032b6570032100). This is the exact wrapper a bare
// third-party verifier uses; no key resolution happens here.
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
 * raw 32-byte public key. Returns false — never throws — on a malformed key or
 * signature, so callers treat it as a single boolean gate.
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

/**
 * Parse a hex-encoded raw Ed25519 public key into a 32-byte Buffer.
 * Returns null on any malformed input (odd length, non-hex, wrong byte count).
 */
export function parsePubkeyHex(hex: string): Buffer | null {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== 64 || !/^[0-9a-f]+$/.test(clean)) return null;
  return Buffer.from(clean, "hex");
}

/** Strip the `#<fragment>` from an agent key id to recover the bare agent DID. */
export function agentDidFromKid(kid: string): string {
  const hash = kid.indexOf("#");
  return hash === -1 ? kid : kid.slice(0, hash);
}
