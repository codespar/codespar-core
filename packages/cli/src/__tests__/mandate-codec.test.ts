import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  agentDidFromKid,
  decodeToken,
  parsePubkeyHex,
  reconstructSigningString,
  verifyEd25519,
  type MandateFields,
} from "../mandate-codec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures/canonical.v3.fixture.json");

interface V3Fixture {
  key: string;
  input: MandateFields & { agent_kid: string; principal_kyc_ref: string };
  canonical_string: string;
  hmac_sha256_hex: string;
  agent_pubkey_hex: string;
  issuer_pubkey_hex: string;
  agent_sig_b64url: string;
  issuer_sig_b64url: string;
}

const fx = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as V3Fixture;

/**
 * Reproduce the enterprise `computeToken` envelope so the CLI decoder has a real
 * presentation token to chew on: base64url JSON of the signed fields + the
 * org-HMAC `signature` + the V3 `agent_sig` / `issuer_sig` / `kid` members.
 */
function makeToken(
  fields: Record<string, unknown>,
  envelope: { signature: string; agent_sig?: string; issuer_sig?: string; kid?: string },
): string {
  return Buffer.from(JSON.stringify({ ...fields, ...envelope }), "utf8").toString("base64url");
}

const TOKEN = makeToken(fx.input as unknown as Record<string, unknown>, {
  signature: fx.hmac_sha256_hex,
  agent_sig: fx.agent_sig_b64url,
  issuer_sig: fx.issuer_sig_b64url,
  kid: fx.input.agent_kid,
});

describe("mandate-codec — decode", () => {
  it("round-trips the V3 envelope and separates it from the signed fields", () => {
    const res = decodeToken(TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { token } = res;
    expect(token.signature).toBe(fx.hmac_sha256_hex);
    expect(token.agent_sig).toBe(fx.agent_sig_b64url);
    expect(token.issuer_sig).toBe(fx.issuer_sig_b64url);
    expect(token.kid).toBe(fx.input.agent_kid);
    // Envelope members must NOT leak into the signed field set.
    const m = token.mandate as unknown as Record<string, unknown>;
    expect(m.agent_sig).toBeUndefined();
    expect(m.issuer_sig).toBeUndefined();
    expect(m.kid).toBeUndefined();
    expect(m.signature).toBeUndefined();
    expect(token.mandate.principal_kyc_ref).toBe(fx.input.principal_kyc_ref);
    expect(token.mandate.agent_kid).toBe(fx.input.agent_kid);
  });

  it("rejects a non-base64url / non-JSON blob", () => {
    const res = decodeToken("!!!not-a-token!!!");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_payload");
  });

  it("rejects an unsupported (v1 / reserved) format_version", () => {
    const bad = makeToken({ ...fx.input, format_version: 1 }, { signature: "deadbeef" });
    const res = decodeToken(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("mandate_format_unsupported");
  });

  it("rejects a V3 payload missing principal_kyc_ref / agent_kid", () => {
    const { principal_kyc_ref, agent_kid, ...rest } = fx.input;
    void principal_kyc_ref;
    void agent_kid;
    const bad = makeToken(rest as unknown as Record<string, unknown>, { signature: "deadbeef" });
    const res = decodeToken(bad);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_payload");
  });
});

describe("mandate-codec — reconstructSigningString (byte-lock)", () => {
  it("reproduces the frozen 14-field canonical string byte-for-byte", () => {
    const s = reconstructSigningString(fx.input as unknown as Record<string, unknown>);
    expect(s).toBe(fx.canonical_string);
  });

  it("reconstructs the same string from the decoded token's mandate fields", () => {
    const res = decodeToken(TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const s = reconstructSigningString(res.token.mandate as unknown as Record<string, unknown>);
    expect(s).toBe(fx.canonical_string);
  });

  it("sorts + escapes purposes independent of input order", () => {
    const s = reconstructSigningString({
      ...fx.input,
      purposes: ["utility", "refund"],
    } as unknown as Record<string, unknown>);
    expect(s).toBe(fx.canonical_string);
  });
});

describe("mandate-codec — Ed25519 verification", () => {
  const signingString = fx.canonical_string;
  const agentPub = () => parsePubkeyHex(fx.agent_pubkey_hex)!;
  const issuerPub = () => parsePubkeyHex(fx.issuer_pubkey_hex)!;

  it("verifies the agent signature with only the DID-document public key", () => {
    expect(verifyEd25519(signingString, fx.agent_sig_b64url, agentPub())).toBe(true);
  });

  it("verifies the issuer signature against the platform public key", () => {
    expect(verifyEd25519(signingString, fx.issuer_sig_b64url, issuerPub())).toBe(true);
  });

  it("fails a one-byte tamper of any signed field", () => {
    const forged = reconstructSigningString({
      ...fx.input,
      amount: "9999",
    } as unknown as Record<string, unknown>);
    expect(forged).not.toBe(signingString);
    expect(verifyEd25519(forged, fx.agent_sig_b64url, agentPub())).toBe(false);
  });

  it("fails when the signing string is truncated by one char", () => {
    expect(verifyEd25519(signingString + "x", fx.agent_sig_b64url, agentPub())).toBe(false);
  });

  it("fails against the wrong public key (issuer key vs agent signature)", () => {
    expect(verifyEd25519(signingString, fx.agent_sig_b64url, issuerPub())).toBe(false);
  });

  it("returns false — never throws — on a malformed key", () => {
    expect(verifyEd25519(signingString, fx.agent_sig_b64url, Buffer.alloc(5))).toBe(false);
  });

  it("swapping agent/issuer signatures fails verification", () => {
    // The issuer signature does not verify under the agent key and vice versa.
    expect(verifyEd25519(signingString, fx.issuer_sig_b64url, agentPub())).toBe(false);
    expect(verifyEd25519(signingString, fx.agent_sig_b64url, issuerPub())).toBe(false);
  });
});

describe("mandate-codec — helpers", () => {
  it("parsePubkeyHex accepts 64 hex chars (with or without 0x) and rejects the rest", () => {
    expect(parsePubkeyHex(fx.agent_pubkey_hex)?.length).toBe(32);
    expect(parsePubkeyHex("0x" + fx.agent_pubkey_hex)?.length).toBe(32);
    expect(parsePubkeyHex("abc")).toBeNull();
    expect(parsePubkeyHex(fx.agent_pubkey_hex + "ff")).toBeNull();
    expect(parsePubkeyHex("zz".repeat(32))).toBeNull();
  });

  it("agentDidFromKid strips the #fragment to recover the bare agent DID", () => {
    expect(agentDidFromKid("did:web:id.codespar.dev:org_demo:a1#1")).toBe(
      "did:web:id.codespar.dev:org_demo:a1",
    );
    expect(agentDidFromKid("did:web:id.codespar.dev:org_demo:a1")).toBe(
      "did:web:id.codespar.dev:org_demo:a1",
    );
  });
});
