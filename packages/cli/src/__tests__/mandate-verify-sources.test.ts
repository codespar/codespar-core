/**
 * `codespar mandate verify` in network mode: which sources a key may come
 * from, and what the user is told about it. Drives the command against a
 * stubbed fetch with the byte-frozen V3 fixture, so the signatures are real
 * and only the key resolution is faked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mandateVerifyCommand } from "../commands/mandate-verify.js";
import { apiFallbackUrl } from "../did.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(
  readFileSync(join(__dirname, "fixtures/canonical.v3.fixture.json"), "utf8"),
) as {
  input: Record<string, unknown> & { agent_kid: string };
  hmac_sha256_hex: string;
  agent_pubkey_hex: string;
  issuer_pubkey_hex: string;
  agent_sig_b64url: string;
  issuer_sig_b64url: string;
};

const TOKEN = Buffer.from(
  JSON.stringify({
    ...fx.input,
    signature: fx.hmac_sha256_hex,
    agent_sig: fx.agent_sig_b64url,
    issuer_sig: fx.issuer_sig_b64url,
    kid: fx.input.agent_kid,
  }),
  "utf8",
).toString("base64url");

// The fixture's agent lives under id.codespar.dev.
const AGENT_DID = "did:web:id.codespar.dev:org_demo:a1";
const ISSUER_DID = "did:web:id.codespar.dev";
const AGENT_URL = "https://id.codespar.dev/org_demo/a1/did.json";
const ISSUER_URL = "https://id.codespar.dev/.well-known/did.json";

function doc(did: string, kid: string, pubkeyHex: string): Record<string, unknown> {
  return {
    id: did,
    verificationMethod: [
      {
        id: kid,
        type: "JsonWebKey2020",
        publicKeyJwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(pubkeyHex, "hex").toString("base64url"),
        },
      },
    ],
  };
}
const AGENT_DOC = doc(AGENT_DID, fx.input.agent_kid, fx.agent_pubkey_hex);
const ISSUER_DOC = doc(ISSUER_DID, `${ISSUER_DID}#1`, fx.issuer_pubkey_hex);

let asked: string[];
let stdout: string;
let stderr: string;
let answers: Record<string, { status: number; body?: unknown }>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  asked = [];
  stdout = "";
  stderr = "";
  answers = {};
  process.exitCode = undefined;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    asked.push(u);
    const a = answers[u] ?? { status: 404 };
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
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

interface Sig {
  status: string;
  source: string | null;
  detail?: string;
}
interface Out {
  verified: boolean;
  signatures: { agent_sig: Sig; issuer_sig: Sig };
}

describe("codespar mandate verify — key sources in network mode", () => {
  it("verifies from the DIDs' own documents and says nothing extra", async () => {
    answers = {
      [AGENT_URL]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: "https://api.codespar.dev", json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.source).toBe("did:web");
    expect(stderr).toBe("");
  });

  it("third-party agent DID with its document unreachable: fails, and the API is never asked for it", async () => {
    // Against a runtime whose domain is not the agent's, the agent DID is a
    // third-party identity. Its document is down; the API would answer — and
    // must not be asked.
    const base = "https://api.other-runtime.example";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, base)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: base, json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(false);
    expect(out.signatures.agent_sig.status).toBe("failed");
    expect(out.signatures.agent_sig.detail).toContain("could not be fetched");
    // No source supplied a key: the JSON says so instead of a pre-set "did:web".
    expect(out.signatures.agent_sig.source).toBeNull();
    expect(asked).not.toContain(apiFallbackUrl(AGENT_DID, base));
    expect(process.exitCode).toBe(1);
  });

  it("--did-domain lets a non-default API answer for the fixture's identity host", async () => {
    const base = "https://api.staging.codespar.dev";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, base)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: base, didDomains: ["id.codespar.dev"], json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.source).toBe("fallback");
  });

  it("a resolver that knows only the agent does not switch off the API route for the issuer", async () => {
    const base = "https://api.codespar.dev";
    const resolver = "https://resolver.example";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, resolver)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 503 },
      // The resolver has no issuer document; the API's own route does.
      [apiFallbackUrl(ISSUER_DID, base)]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: base, resolver, json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.source).toBe("resolver");
    expect(out.signatures.issuer_sig.source).toBe("fallback");
    expect(asked).toContain(apiFallbackUrl(ISSUER_DID, resolver));
  });

  it("--resolver must be an absolute http(s) URL", async () => {
    for (const bad of ["resolver.example", "ftp://resolver.example", "/v1"]) {
      await expect(
        mandateVerifyCommand(TOKEN, { baseUrl: "https://api.codespar.dev", resolver: bad, json: true }),
      ).rejects.toThrow(/--resolver must be an/);
    }
    expect(asked).toEqual([]);
  });

  it("--did-domain must be a host or URL", async () => {
    await expect(
      mandateVerifyCommand(TOKEN, {
        baseUrl: "https://api.codespar.dev",
        didDomains: ["not a host"],
        json: true,
      }),
    ).rejects.toThrow(/--did-domain: identity host must be a host or URL/);
    expect(asked).toEqual([]);
  });

  it("--did-domain accepts a URL and normalises it to the host", async () => {
    const base = "https://api.staging.codespar.dev";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, base)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, {
      baseUrl: base,
      didDomains: ["https://ID.codespar.dev:8443/"],
      json: true,
    });
    expect((JSON.parse(stdout) as Out).signatures.agent_sig.source).toBe("fallback");
  });

  it("agent and issuer resolve in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = (async (url: string | URL) => {
      asked.push(String(url));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      const body = String(url) === AGENT_URL ? AGENT_DOC : ISSUER_DOC;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    await mandateVerifyCommand(TOKEN, { baseUrl: "https://api.codespar.dev", json: true });
    expect((JSON.parse(stdout) as Out).verified).toBe(true);
    expect(maxInFlight).toBe(2);
  });

  it("--resolver: keys come from the resolver, the source says so and stderr warns", async () => {
    const base = "https://api.other-runtime.example";
    const resolver = "https://resolver.example";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, resolver)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: base, resolver, json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.source).toBe("resolver");
    expect(stderr).toContain(`${AGENT_DID}: keys came from the resolver at`);
    expect(stderr).toContain("not from the domain's did:web document");
    expect(asked).not.toContain(apiFallbackUrl(AGENT_DID, base));
  });

  it("own-domain agent DID with its document unreachable: the API route is used and announced", async () => {
    const base = "https://api.codespar.dev";
    answers = {
      [AGENT_URL]: { status: 503 },
      [apiFallbackUrl(AGENT_DID, base)]: { status: 200, body: AGENT_DOC },
      [ISSUER_URL]: { status: 200, body: ISSUER_DOC },
    };
    await mandateVerifyCommand(TOKEN, { baseUrl: base, json: true });
    const out = JSON.parse(stdout) as Out;
    expect(out.verified).toBe(true);
    expect(out.signatures.agent_sig.source).toBe("fallback");
    expect(stderr).toContain("keys came from the API's DID route");
  });
});
