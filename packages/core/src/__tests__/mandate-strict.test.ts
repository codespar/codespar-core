/**
 * p2-identity#6 (codespar-core#123): what `verifyMandateToken` may call
 * "verified".
 *
 * Three verdicts the verifier used to give and must not:
 *   - verified with the agent signature missing (only the platform signed);
 *   - verified by a key the token does not name (a retired key verified
 *     tokens that name the active one, forever);
 *   - verified after `expires_at`.
 * And one format it could not read: V4, which signs `issued_at`.
 *
 * Every refusal below sits next to the closest legitimate token still
 * verifying, so a verifier that refuses everything fails this file too.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeMandateToken,
  reconstructSigningString,
  verifyMandateToken,
} from "../mandate/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  input: Record<string, unknown> & { agent_kid: string; expires_at: number; issued_at?: number };
  canonical_string: string;
  hmac_sha256_hex: string;
  agent_seed_hex: string;
  agent_pubkey_hex: string;
  issuer_seed_hex: string;
  issuer_pubkey_hex: string;
  agent_sig_b64url: string;
  issuer_sig_b64url: string;
}

const load = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8")) as Fixture;
const v3 = load("canonical.v3.fixture.json");
const v4 = load("canonical.v4.fixture.json");

// The fixtures expire at 2025-01-01T00:00:00Z. BEFORE is inside the window;
// AFTER is one second past it.
const BEFORE = v3.input.expires_at - 12 * 3600;
const AFTER = v3.input.expires_at + 1;

function makeToken(fields: Record<string, unknown>, envelope: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ ...fields, ...envelope }), "utf8").toString("base64url");
}

function fixtureToken(fx: Fixture, drop: string[] = []): string {
  const envelope: Record<string, unknown> = {
    signature: fx.hmac_sha256_hex,
    agent_sig: fx.agent_sig_b64url,
    issuer_sig: fx.issuer_sig_b64url,
    kid: fx.input.agent_kid,
  };
  for (const k of drop) delete envelope[k];
  return makeToken(fx.input, envelope);
}

const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
function signWith(seedHex: string, message: string): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
}
function freshKey(): { seedHex: string; pubHex: string } {
  const seed = randomBytes(32);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return { seedHex: seed.toString("hex"), pubHex: spki.subarray(spki.length - 32).toString("hex") };
}

function didDoc(did: string, keys: { kid: string; pubHex: string }[]): Record<string, unknown> {
  return {
    id: did,
    verificationMethod: keys.map((k) => ({
      id: k.kid,
      type: "JsonWebKey2020",
      controller: did,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(k.pubHex, "hex").toString("base64url") },
    })),
  };
}

const BOTH = { agentPublicKey: v3.agent_pubkey_hex, issuerPublicKey: v3.issuer_pubkey_hex };

describe("control: a legitimate token still verifies", () => {
  it("V3 with both signatures, both keys, inside its window", () => {
    const res = verifyMandateToken(fixtureToken(v3), { ...BOTH, now: BEFORE });
    expect(res.verified).toBe(true);
    expect(res.failures).toEqual([]);
    expect(res.expired).toBe(false);
  });

  it("a tampered V3 token still fails", () => {
    const tampered = makeToken(
      { ...v3.input, amount: "9999" },
      { signature: v3.hmac_sha256_hex, agent_sig: v3.agent_sig_b64url, issuer_sig: v3.issuer_sig_b64url, kid: v3.input.agent_kid },
    );
    const res = verifyMandateToken(tampered, { ...BOTH, now: BEFORE });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("failed");
    expect(res.issuer.status).toBe("failed");
    expect(res.failures).toEqual(expect.arrayContaining(["agent_sig_invalid", "issuer_sig_invalid"]));
  });
});

describe("rule 1: a signature the token does not carry is a failure", () => {
  it("agent_sig stripped: NOT verified, though the platform signature checks", () => {
    const res = verifyMandateToken(fixtureToken(v3, ["agent_sig"]), { ...BOTH, now: BEFORE });
    expect(res.verified).toBe(false);
    expect(res.issuer.status).toBe("verified");
    expect(res.agent.status).toBe("absent");
    expect(res.failures).toEqual(["agent_sig_absent"]);
  });

  it("issuer_sig stripped: NOT verified either", () => {
    const res = verifyMandateToken(fixtureToken(v3, ["issuer_sig"]), { ...BOTH, now: BEFORE });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("verified");
    expect(res.failures).toEqual(["issuer_sig_absent"]);
  });

  it("a carried signature nobody checked is not verified (no key supplied)", () => {
    const res = verifyMandateToken(fixtureToken(v3), { agentPublicKey: v3.agent_pubkey_hex, now: BEFORE });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("verified");
    expect(res.issuer.status).toBe("skipped");
    expect(res.failures).toEqual(["issuer_sig_unchecked"]);
  });
});

describe("rule 2: only the key the token names", () => {
  const agentDid = "did:web:id.codespar.dev:org_demo:a1";
  const retiredKid = `${agentDid}#1`; // the fixture's agent key, retired by a rotation
  const activeKid = `${agentDid}#2`;
  const active = freshKey();
  const document = didDoc(agentDid, [
    { kid: retiredKid, pubHex: v3.agent_pubkey_hex },
    { kid: activeKid, pubHex: active.pubHex },
  ]);

  /** A V3 token naming `namedKid`, agent-signed with `agentSeed`, issuer-signed by the platform. */
  function tokenNaming(namedKid: string, agentSeedHex: string): string {
    const fields = { ...v3.input, agent_kid: namedKid };
    const s = reconstructSigningString(fields);
    return makeToken(fields, {
      signature: "00",
      agent_sig: signWith(agentSeedHex, s),
      issuer_sig: signWith(v3.issuer_seed_hex, s),
      kid: namedKid,
    });
  }

  it("the retired key does not verify a token that names the active key", () => {
    const res = verifyMandateToken(tokenNaming(activeKid, v3.agent_seed_hex), {
      agentDidDocument: document,
      issuerPublicKey: v3.issuer_pubkey_hex,
      now: BEFORE,
    });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("failed");
    expect(res.agent.kid).toBe(activeKid);
    expect(res.failures).toEqual(["agent_sig_invalid"]);
  });

  it("control: the active key verifies the token that names it, from the same document", () => {
    const res = verifyMandateToken(tokenNaming(activeKid, active.seedHex), {
      agentDidDocument: document,
      issuerPublicKey: v3.issuer_pubkey_hex,
      now: BEFORE,
    });
    expect(res.verified).toBe(true);
    expect(res.agent.kid).toBe(activeKid);
  });

  it("a kid the document does not publish fails, and no other key is tried", () => {
    const res = verifyMandateToken(tokenNaming(`${agentDid}#9`, v3.agent_seed_hex), {
      agentDidDocument: document,
      issuerPublicKey: v3.issuer_pubkey_hex,
      now: BEFORE,
    });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("failed");
    expect(res.failures).toEqual(["kid_not_in_document"]);
  });

  it("the unsigned envelope kid cannot rename the signed agent_kid", () => {
    // Signed agent_kid is #1 (the fixture); the envelope claims #2.
    const t = makeToken(v3.input, {
      signature: v3.hmac_sha256_hex,
      agent_sig: v3.agent_sig_b64url,
      issuer_sig: v3.issuer_sig_b64url,
      kid: activeKid,
    });
    const res = verifyMandateToken(t, { ...BOTH, now: BEFORE });
    expect(res.verified).toBe(false);
    expect(res.kid).toBe(v3.input.agent_kid);
    expect(res.agent.status).toBe("failed");
    expect(res.failures).toEqual(["kid_mismatch"]);
  });

  it("agentPublicKey and agentDidDocument together are refused", () => {
    expect(() =>
      verifyMandateToken(fixtureToken(v3), {
        agentPublicKey: v3.agent_pubkey_hex,
        agentDidDocument: document,
        now: BEFORE,
      }),
    ).toThrow(/not both/);
  });
});

describe("rule 3: an expired token is not verified", () => {
  it("one second past expires_at: NOT verified, and says why", () => {
    const res = verifyMandateToken(fixtureToken(v3), { ...BOTH, now: AFTER });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("verified");
    expect(res.issuer.status).toBe("verified");
    expect(res.expired).toBe(true);
    expect(res.failures).toEqual(["expired"]);
  });

  it("with no clock given, the verifier reads the real one (the fixtures expired in 2025)", () => {
    const res = verifyMandateToken(fixtureToken(v3), BOTH);
    expect(res.verified).toBe(false);
    expect(res.expired).toBe(true);
  });

  it("at expires_at exactly it is still valid (the API refuses only after it)", () => {
    const res = verifyMandateToken(fixtureToken(v3), { ...BOTH, now: v3.input.expires_at });
    expect(res.verified).toBe(true);
  });
});

describe("V4 (issued_at signed)", () => {
  it("reconstructs the frozen 15-field V4 canonical string byte-for-byte", () => {
    expect(reconstructSigningString(v4.input)).toBe(v4.canonical_string);
  });

  it("a V4 token verifies and exposes issued_at", () => {
    const res = verifyMandateToken(fixtureToken(v4), {
      agentPublicKey: v4.agent_pubkey_hex,
      issuerPublicKey: v4.issuer_pubkey_hex,
      now: BEFORE,
    });
    expect(res.verified).toBe(true);
    expect(res.issuedAt).toBe(v4.input.issued_at);
    expect(res.mandate.format_version).toBe(4);
  });

  it("a one-second change to issued_at breaks both signatures", () => {
    const t = makeToken(
      { ...v4.input, issued_at: (v4.input.issued_at ?? 0) + 1 },
      { signature: v4.hmac_sha256_hex, agent_sig: v4.agent_sig_b64url, issuer_sig: v4.issuer_sig_b64url, kid: v4.input.agent_kid },
    );
    const res = verifyMandateToken(t, {
      agentPublicKey: v4.agent_pubkey_hex,
      issuerPublicKey: v4.issuer_pubkey_hex,
      now: BEFORE,
    });
    expect(res.verified).toBe(false);
    expect(res.failures).toEqual(["agent_sig_invalid", "issuer_sig_invalid"]);
  });

  it("a V4 payload without issued_at is malformed", () => {
    const { issued_at, ...rest } = v4.input;
    void issued_at;
    const res = decodeMandateToken(makeToken(rest, { signature: "00" }));
    expect(res).toEqual({ ok: false, error: "invalid_payload" });
  });

  it("a format this verifier does not know is unsupported, not reconstructed as V3", () => {
    const res = decodeMandateToken(makeToken({ ...v4.input, format_version: 5 }, { signature: "00" }));
    expect(res).toEqual({ ok: false, error: "mandate_format_unsupported" });
  });
});
