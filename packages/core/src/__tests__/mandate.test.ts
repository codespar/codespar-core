import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  agentDidFromKid,
  decodeMandateToken,
  reconstructSigningString,
  verifyEd25519,
  verifyMandateToken,
  type MandateFields,
} from "../mandate/index.js";

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

/** Reproduce the enterprise `computeToken` envelope so we have a real token. */
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

describe("@codespar/sdk/mandate — decode", () => {
  it("round-trips the V3 envelope and separates it from the signed fields", () => {
    const res = decodeMandateToken(TOKEN);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.token.signature).toBe(fx.hmac_sha256_hex);
    expect(res.token.agent_sig).toBe(fx.agent_sig_b64url);
    expect(res.token.issuer_sig).toBe(fx.issuer_sig_b64url);
    expect(res.token.kid).toBe(fx.input.agent_kid);
    const m = res.token.mandate as unknown as Record<string, unknown>;
    expect(m.signature).toBeUndefined();
    expect(m.agent_sig).toBeUndefined();
    expect(m.issuer_sig).toBeUndefined();
    expect(m.kid).toBeUndefined();
  });

  it("rejects a non-base64url / non-JSON blob", () => {
    const res = decodeMandateToken("!!!nope!!!");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_payload");
  });

  it("rejects an unsupported (v1) format_version", () => {
    const res = decodeMandateToken(makeToken({ ...fx.input, format_version: 1 }, { signature: "x" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("mandate_format_unsupported");
  });
});

describe("@codespar/sdk/mandate — reconstructSigningString (byte-lock)", () => {
  it("reproduces the frozen 14-field canonical string byte-for-byte", () => {
    expect(reconstructSigningString(fx.input as unknown as Record<string, unknown>)).toBe(
      fx.canonical_string,
    );
  });

  it("sorts + escapes purposes independent of input order", () => {
    expect(
      reconstructSigningString({
        ...fx.input,
        purposes: ["utility", "refund"],
      } as unknown as Record<string, unknown>),
    ).toBe(fx.canonical_string);
  });
});

describe("@codespar/sdk/mandate — verifyEd25519", () => {
  const agentPub = () => Buffer.from(fx.agent_pubkey_hex, "hex");
  const issuerPub = () => Buffer.from(fx.issuer_pubkey_hex, "hex");

  it("verifies agent + issuer signatures with only the DID public keys", () => {
    expect(verifyEd25519(fx.canonical_string, fx.agent_sig_b64url, agentPub())).toBe(true);
    expect(verifyEd25519(fx.canonical_string, fx.issuer_sig_b64url, issuerPub())).toBe(true);
  });

  it("fails a one-byte tamper of a signed field", () => {
    const forged = reconstructSigningString({
      ...fx.input,
      amount: "9999",
    } as unknown as Record<string, unknown>);
    expect(verifyEd25519(forged, fx.agent_sig_b64url, agentPub())).toBe(false);
  });

  it("fails against the wrong key and never throws on a malformed key", () => {
    expect(verifyEd25519(fx.canonical_string, fx.agent_sig_b64url, issuerPub())).toBe(false);
    expect(verifyEd25519(fx.canonical_string, fx.agent_sig_b64url, Buffer.alloc(5))).toBe(false);
  });
});

describe("@codespar/sdk/mandate — verifyMandateToken (high-level)", () => {
  it("verifies both signatures from hex keys and exposes governed fields", () => {
    const res = verifyMandateToken(TOKEN, {
      agentPublicKey: fx.agent_pubkey_hex,
      issuerPublicKey: fx.issuer_pubkey_hex,
    });
    expect(res.verified).toBe(true);
    expect(res.agent.status).toBe("verified");
    expect(res.issuer.status).toBe("verified");
    expect(res.agent.kid).toBe(fx.input.agent_kid);
    expect(res.agentDid).toBe("did:web:id.codespar.dev:org_demo:a1");
    expect(res.kid).toBe(fx.input.agent_kid);
    expect(res.mandate.purposes).toContain("refund");
    expect(res.mandate.amount).toBe("5000");
  });

  it("accepts raw byte keys as well as hex", () => {
    const res = verifyMandateToken(TOKEN, {
      agentPublicKey: Buffer.from(fx.agent_pubkey_hex, "hex"),
      issuerPublicKey: Buffer.from(fx.issuer_pubkey_hex, "hex"),
    });
    expect(res.verified).toBe(true);
  });

  it("skips a signature when its key is not supplied (still verified overall)", () => {
    const res = verifyMandateToken(TOKEN, { agentPublicKey: fx.agent_pubkey_hex });
    expect(res.agent.status).toBe("verified");
    expect(res.issuer.status).toBe("skipped");
    expect(res.verified).toBe(true);
  });

  it("reports NOT verified when a supplied key fails", () => {
    // Issuer key given for the agent slot → agent signature fails.
    const res = verifyMandateToken(TOKEN, { agentPublicKey: fx.issuer_pubkey_hex });
    expect(res.agent.status).toBe("failed");
    expect(res.verified).toBe(false);
  });

  it("reports NOT verified for a tampered token", () => {
    const tampered = makeToken(
      { ...fx.input, amount: "9999" },
      {
        signature: fx.hmac_sha256_hex,
        agent_sig: fx.agent_sig_b64url,
        issuer_sig: fx.issuer_sig_b64url,
        kid: fx.input.agent_kid,
      },
    );
    const res = verifyMandateToken(tampered, {
      agentPublicKey: fx.agent_pubkey_hex,
      issuerPublicKey: fx.issuer_pubkey_hex,
    });
    expect(res.verified).toBe(false);
    expect(res.agent.status).toBe("failed");
    expect(res.issuer.status).toBe("failed");
  });

  it("throws on a token that cannot be decoded", () => {
    expect(() => verifyMandateToken("not-a-token")).toThrow(/cannot decode/);
  });

  it("rejects a malformed hex key by treating it as no key (skipped)", () => {
    const res = verifyMandateToken(TOKEN, { agentPublicKey: "xyz" });
    expect(res.agent.status).toBe("skipped");
    expect(res.verified).toBe(false);
  });
});

describe("@codespar/sdk/mandate — helpers", () => {
  it("agentDidFromKid strips the #fragment", () => {
    expect(agentDidFromKid("did:web:id.codespar.dev:org_demo:a1#1")).toBe(
      "did:web:id.codespar.dev:org_demo:a1",
    );
  });
});
