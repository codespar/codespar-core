/**
 * p2-identity#6 (codespar-core#123): what `codespar mandate verify` may print
 * as "verified".
 *
 * Three verdicts the command used to give and must not:
 *   - verified with the agent signature missing (only the platform signed);
 *   - verified by a key the token does not name: every key of the agent's DID
 *     document was tried, and the document lists retired keys on purpose, so
 *     a retired key verified tokens naming the active one, forever;
 *   - verified after `expires_at`.
 * And one format it could not read: V4, which signs `issued_at`.
 *
 * Every refusal sits next to the closest legitimate token still verifying.
 * Signatures are real (the enterprise byte-frozen fixtures plus keys minted
 * here); only DID resolution is stubbed.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mandateVerifyCommand } from "../commands/mandate-verify.js";
import { reconstructSigningString } from "../mandate-codec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Fixture {
  input: Record<string, unknown> & { agent_kid: string; expires_at: number; issued_at?: number };
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

// The fixtures expire at 2025-01-01T00:00:00Z.
const BEFORE_MS = (v3.input.expires_at - 12 * 3600) * 1000;

const AGENT_DID = "did:web:id.codespar.dev:org_demo:a1";
const ISSUER_DID = "did:web:id.codespar.dev";
const AGENT_URL = "https://id.codespar.dev/org_demo/a1/did.json";
const ISSUER_URL = "https://id.codespar.dev/.well-known/did.json";
const RETIRED_KID = `${AGENT_DID}#1`; // the fixture's agent key, retired by a rotation
const ACTIVE_KID = `${AGENT_DID}#2`;

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
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
}
function freshKey(): { seedHex: string; pubHex: string } {
  const seed = randomBytes(32);
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return { seedHex: seed.toString("hex"), pubHex: spki.subarray(spki.length - 32).toString("hex") };
}

/** A V3 token naming `namedKid`, agent-signed with `agentSeedHex`, issuer-signed by the platform. */
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

function doc(did: string, keys: { kid: string; pubHex: string }[]): Record<string, unknown> {
  return {
    id: did,
    verificationMethod: keys.map((k) => ({
      id: k.kid,
      type: "JsonWebKey2020",
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: Buffer.from(k.pubHex, "hex").toString("base64url") },
    })),
  };
}
const ISSUER_DOC = doc(ISSUER_DID, [{ kid: `${ISSUER_DID}#1`, pubHex: v3.issuer_pubkey_hex }]);
const active = freshKey();
const ROTATED_AGENT_DOC = doc(AGENT_DID, [
  { kid: RETIRED_KID, pubHex: v3.agent_pubkey_hex },
  { kid: ACTIVE_KID, pubHex: active.pubHex },
]);
const AGENT_DOC = doc(AGENT_DID, [{ kid: RETIRED_KID, pubHex: v3.agent_pubkey_hex }]);

let stdout: string;
let stderr: string;
let answers: Record<string, { status: number; body?: unknown }>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  stdout = "";
  stderr = "";
  answers = {
    [AGENT_URL]: { status: 200, body: AGENT_DOC },
    [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
  };
  process.exitCode = undefined;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BEFORE_MS);
  globalThis.fetch = (async (url: string | URL) => {
    const a = answers[String(url)] ?? { status: 404 };
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

interface Out {
  verified: boolean;
  failures: string[];
  signatures: { agent_sig: { status: string; kid: string | null }; issuer_sig: { status: string } };
  mandate: { kid: string | null; expired: boolean; issued_at: number | null; format_version: number };
}
const BASE = "https://api.codespar.dev";
async function verifyJson(token: string, extra: Record<string, unknown> = {}): Promise<Out> {
  await mandateVerifyCommand(token, { baseUrl: BASE, json: true, ...extra });
  return JSON.parse(stdout) as Out;
}
const OFFLINE_BOTH = { agentPubkey: v3.agent_pubkey_hex, issuerPubkey: v3.issuer_pubkey_hex };

describe("control: a legitimate token still verifies", () => {
  it("V3 in network mode, inside its window", async () => {
    const out = await verifyJson(fixtureToken(v3));
    expect(out.verified).toBe(true);
    expect(out.failures).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("V3 in offline mode with both keys", async () => {
    const out = await verifyJson(fixtureToken(v3), OFFLINE_BOTH);
    expect(out.verified).toBe(true);
  });

  it("a tampered V3 token still fails", async () => {
    const t = makeToken(
      { ...v3.input, amount: "9999" },
      { signature: v3.hmac_sha256_hex, agent_sig: v3.agent_sig_b64url, issuer_sig: v3.issuer_sig_b64url, kid: v3.input.agent_kid },
    );
    const out = await verifyJson(t);
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["agent_sig_invalid", "issuer_sig_invalid"]);
    expect(process.exitCode).toBe(1);
  });
});

describe("rule 1: a signature the token does not carry is a failure", () => {
  it("agent_sig stripped, network mode: NOT verified though the platform signature checks", async () => {
    const out = await verifyJson(fixtureToken(v3, ["agent_sig"]));
    expect(out.verified).toBe(false);
    expect(out.signatures.issuer_sig.status).toBe("verified");
    expect(out.signatures.agent_sig.status).toBe("absent");
    expect(out.failures).toEqual(["agent_sig_absent"]);
    expect(process.exitCode).toBe(1);
  });

  it("agent_sig stripped, offline mode with both keys: NOT verified", async () => {
    const out = await verifyJson(fixtureToken(v3, ["agent_sig"]), OFFLINE_BOTH);
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["agent_sig_absent"]);
  });

  it("issuer_sig stripped: NOT verified either", async () => {
    const out = await verifyJson(fixtureToken(v3, ["issuer_sig"]));
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["issuer_sig_absent"]);
  });

  it("offline with only --issuer-pubkey: the agent signature was not checked, so NOT verified", async () => {
    const out = await verifyJson(fixtureToken(v3), { issuerPubkey: v3.issuer_pubkey_hex });
    expect(out.verified).toBe(false);
    expect(out.signatures.agent_sig.status).toBe("skipped");
    expect(out.failures).toEqual(["agent_sig_unchecked"]);
  });
});

describe("rule 2: only the key the token names", () => {
  it("a retired key in the document does not verify a token that names the active key", async () => {
    answers[AGENT_URL] = { status: 200, body: ROTATED_AGENT_DOC };
    const out = await verifyJson(tokenNaming(ACTIVE_KID, v3.agent_seed_hex));
    expect(out.verified).toBe(false);
    expect(out.signatures.agent_sig.status).toBe("failed");
    expect(out.signatures.agent_sig.kid).toBe(ACTIVE_KID);
    expect(out.failures).toEqual(["agent_sig_invalid"]);
  });

  it("control: the active key verifies the token that names it, from the same document", async () => {
    answers[AGENT_URL] = { status: 200, body: ROTATED_AGENT_DOC };
    const out = await verifyJson(tokenNaming(ACTIVE_KID, active.seedHex));
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.kid).toBe(ACTIVE_KID);
  });

  it("a kid the document does not publish fails, and the key that is there is not tried", async () => {
    const out = await verifyJson(tokenNaming(`${AGENT_DID}#9`, v3.agent_seed_hex));
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["kid_not_in_document"]);
  });

  it("the unsigned envelope kid cannot rename the signed agent_kid", async () => {
    answers[AGENT_URL] = { status: 200, body: ROTATED_AGENT_DOC };
    const t = makeToken(v3.input, {
      signature: v3.hmac_sha256_hex,
      agent_sig: v3.agent_sig_b64url,
      issuer_sig: v3.issuer_sig_b64url,
      kid: ACTIVE_KID,
    });
    const out = await verifyJson(t);
    expect(out.verified).toBe(false);
    expect(out.mandate.kid).toBe(v3.input.agent_kid);
    expect(out.failures).toEqual(["kid_mismatch"]);
  });
});

describe("rule 3: an expired token is not verified", () => {
  it("one second past expires_at, network mode: NOT verified, and says why", async () => {
    vi.setSystemTime((v3.input.expires_at + 1) * 1000);
    const out = await verifyJson(fixtureToken(v3));
    expect(out.verified).toBe(false);
    expect(out.signatures.agent_sig.status).toBe("verified");
    expect(out.signatures.issuer_sig.status).toBe("verified");
    expect(out.mandate.expired).toBe(true);
    expect(out.failures).toEqual(["expired"]);
    expect(process.exitCode).toBe(1);
  });

  it("offline mode too", async () => {
    vi.setSystemTime((v3.input.expires_at + 1) * 1000);
    const out = await verifyJson(fixtureToken(v3), OFFLINE_BOTH);
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["expired"]);
  });

  it("the human output says NOT verified and names the reason", async () => {
    vi.setSystemTime((v3.input.expires_at + 1) * 1000);
    await mandateVerifyCommand(fixtureToken(v3), { baseUrl: BASE });
    expect(stderr).toContain("mandate token NOT verified");
    expect(stderr).toContain("Not verified: the mandate is past expires_at.");
    expect(stdout).toContain("[expired]");
    expect(process.exitCode).toBe(1);
  });
});

describe("V4 (issued_at signed)", () => {
  it("a V4 token verifies in network mode and shows issued_at", async () => {
    const out = await verifyJson(fixtureToken(v4));
    expect(out.verified).toBe(true);
    expect(out.mandate.format_version).toBe(4);
    expect(out.mandate.issued_at).toBe(v4.input.issued_at);
  });

  it("a one-second change to issued_at breaks both signatures", async () => {
    const t = makeToken(
      { ...v4.input, issued_at: (v4.input.issued_at ?? 0) + 1 },
      { signature: v4.hmac_sha256_hex, agent_sig: v4.agent_sig_b64url, issuer_sig: v4.issuer_sig_b64url, kid: v4.input.agent_kid },
    );
    const out = await verifyJson(t);
    expect(out.verified).toBe(false);
    expect(out.failures).toEqual(["agent_sig_invalid", "issuer_sig_invalid"]);
  });
});
