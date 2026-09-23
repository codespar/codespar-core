import { describe, it, expect, afterEach } from "vitest";
import {
  apiFallbackUrl,
  didWebHost,
  didWebToUrl,
  isOwnDid,
  ownDomainSuffix,
  resolveDidKeys,
} from "../did.js";

describe("did:web URL mapping", () => {
  it("maps a bare domain DID to /.well-known/did.json", () => {
    expect(didWebToUrl("did:web:id.codespar.dev")).toBe(
      "https://id.codespar.dev/.well-known/did.json",
    );
  });

  it("maps a path DID to /<segments>/did.json", () => {
    expect(didWebToUrl("did:web:id.codespar.dev:org_demo:a1")).toBe(
      "https://id.codespar.dev/org_demo/a1/did.json",
    );
  });

  it("decodes a %3A port in the domain segment", () => {
    expect(didWebToUrl("did:web:localhost%3A8080:org:a1")).toBe(
      "https://localhost:8080/org/a1/did.json",
    );
  });

  it("returns null for a non-did:web input", () => {
    expect(didWebToUrl("did:key:z6Mk...")).toBeNull();
    expect(didWebToUrl("not-a-did")).toBeNull();
  });

  it("builds the api.codespar.dev fallback with the full DID url-encoded", () => {
    expect(apiFallbackUrl("did:web:id.codespar.dev:org_demo:a1", "https://api.codespar.dev")).toBe(
      "https://api.codespar.dev/v1/agents/did%3Aweb%3Aid.codespar.dev%3Aorg_demo%3Aa1/did.json",
    );
  });

  it("trims a trailing slash on the base URL for the fallback", () => {
    expect(apiFallbackUrl("did:web:id.codespar.dev", "https://api.codespar.dev/")).toBe(
      "https://api.codespar.dev/v1/agents/did%3Aweb%3Aid.codespar.dev/did.json",
    );
  });
});

describe("own-domain scoping", () => {
  it("didWebHost lowercases and strips a port", () => {
    expect(didWebHost("did:web:ID.Codespar.dev:org:a1")).toBe("id.codespar.dev");
    expect(didWebHost("did:web:localhost%3A8080:org:a1")).toBe("localhost");
    expect(didWebHost("did:key:z6Mk")).toBeNull();
  });

  it("ownDomainSuffix drops the first label of a three-label host", () => {
    expect(ownDomainSuffix("https://api.codespar.dev")).toBe("codespar.dev");
    expect(ownDomainSuffix("https://codespar.dev")).toBe("codespar.dev");
    expect(ownDomainSuffix("http://localhost:3000")).toBe("localhost");
    expect(ownDomainSuffix("not a url")).toBeNull();
  });

  it("isOwnDid accepts the API's own domain family and nothing else", () => {
    const base = "https://api.codespar.dev";
    expect(isOwnDid("did:web:id.codespar.dev:org:a1", base)).toBe(true);
    expect(isOwnDid("did:web:codespar.dev", base)).toBe(true);
    expect(isOwnDid("did:web:id.other-runtime.example:org:a1", base)).toBe(false);
    expect(isOwnDid("did:web:codespar.dev.evil.example", base)).toBe(false);
    expect(isOwnDid("did:web:notcodespar.dev", base)).toBe(false);
    expect(isOwnDid("did:key:z6Mk", base)).toBe(false);
  });

  it("isOwnDid honours configured extra suffixes", () => {
    expect(
      isOwnDid("did:web:id.partner.example:a1", "https://api.codespar.dev", ["partner.example"]),
    ).toBe(true);
  });
});

/* ── resolveDidKeys against a stubbed fetch ──────────────────────
 *
 * The fetch stub records every URL asked for, so a test can prove not only
 * what was resolved but which sources were NOT consulted.
 * ─────────────────────────────────────────────────────────────── */

const OWN_DID = "did:web:id.codespar.dev:org_demo:a1";
const THIRD_DID = "did:web:id.other-runtime.example:org:a1";
const BASE = "https://api.codespar.dev";
const STANDARD_OWN = "https://id.codespar.dev/org_demo/a1/did.json";
const STANDARD_THIRD = "https://id.other-runtime.example/org/a1/did.json";

function didDocument(did: string, kids: string[] = ["1"]): Record<string, unknown> {
  return {
    id: did,
    verificationMethod: kids.map((n) => ({
      id: `${did}#${n}`,
      type: "JsonWebKey2020",
      publicKeyJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.alloc(32, Number(n)).toString("base64url"),
      },
    })),
  };
}

type Answer = { status: number; body?: unknown } | "throw";

/** Stub fetch: answers by URL, records the order asked. Unlisted URL → 404. */
function stubFetch(answers: Record<string, Answer>): { asked: string[]; restore: () => void } {
  const asked: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    asked.push(u);
    const a = answers[u] ?? { status: 404 };
    if (a === "throw") throw new TypeError("fetch failed");
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return {
    asked,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("resolveDidKeys", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("uses the standard did:web document when it carries keys, and consults nothing else", async () => {
    const stub = stubFetch({ [STANDARD_OWN]: { status: 200, body: didDocument(OWN_DID, ["1", "2"]) } });
    restore = stub.restore;
    const r = await resolveDidKeys(OWN_DID, { baseUrl: BASE, preferredKid: `${OWN_DID}#2` });
    expect(r.source).toBe("did:web");
    expect(r.keys.map((k) => k.kid)).toEqual([`${OWN_DID}#2`, `${OWN_DID}#1`]);
    expect(stub.asked).toEqual([STANDARD_OWN]);
  });

  it("own-domain DID with the standard document unreachable → the API route is used", async () => {
    const fallback = apiFallbackUrl(OWN_DID, BASE);
    const stub = stubFetch({
      [STANDARD_OWN]: { status: 503 },
      [fallback]: { status: 200, body: didDocument(OWN_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(OWN_DID, { baseUrl: BASE });
    expect(r.source).toBe("fallback");
    expect(r.keys).toHaveLength(1);
    expect(stub.asked).toEqual([STANDARD_OWN, fallback]);
    expect(r.tried).toEqual([STANDARD_OWN, fallback]);
  });

  it("a network failure on the standard document counts as unreachable", async () => {
    const fallback = apiFallbackUrl(OWN_DID, BASE);
    const stub = stubFetch({
      [STANDARD_OWN]: "throw",
      [fallback]: { status: 200, body: didDocument(OWN_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(OWN_DID, { baseUrl: BASE });
    expect(r.source).toBe("fallback");
  });

  it("third-party DID with the standard document unreachable → no keys, API route NEVER asked", async () => {
    const fallback = apiFallbackUrl(THIRD_DID, BASE);
    const stub = stubFetch({
      [STANDARD_THIRD]: { status: 503 },
      // Even if the API would answer, it must not be asked.
      [fallback]: { status: 200, body: didDocument(THIRD_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(THIRD_DID, { baseUrl: BASE });
    expect(r.keys).toEqual([]);
    expect(r.source).toBeNull();
    expect(stub.asked).toEqual([STANDARD_THIRD]);
    expect(r.detail).toContain("could not be fetched");
    expect(r.detail).toContain("id.other-runtime.example is not under codespar.dev");
  });

  it("a fetched document without an Ed25519 key ends the resolution: no fallback, even for an own-domain DID", async () => {
    const fallback = apiFallbackUrl(OWN_DID, BASE);
    const stub = stubFetch({
      [STANDARD_OWN]: { status: 200, body: { id: OWN_DID, verificationMethod: [] } },
      [fallback]: { status: 200, body: didDocument(OWN_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(OWN_DID, { baseUrl: BASE });
    expect(r.keys).toEqual([]);
    expect(stub.asked).toEqual([STANDARD_OWN]);
    expect(r.detail).toContain("carries no Ed25519 key");
  });

  it("an explicit resolver is used for a third-party DID whose document is unreachable, and reported as the source", async () => {
    const resolver = "https://resolver.example";
    const viaResolver = apiFallbackUrl(THIRD_DID, resolver);
    const stub = stubFetch({
      [STANDARD_THIRD]: { status: 503 },
      [viaResolver]: { status: 200, body: didDocument(THIRD_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(THIRD_DID, { baseUrl: BASE, resolverUrl: resolver });
    expect(r.source).toBe("resolver");
    expect(r.keys).toHaveLength(1);
    expect(stub.asked).toEqual([STANDARD_THIRD, viaResolver]);
  });

  it("an explicit resolver does not pre-empt a standard document that answers", async () => {
    const resolver = "https://resolver.example";
    const stub = stubFetch({
      [STANDARD_THIRD]: { status: 200, body: didDocument(THIRD_DID) },
    });
    restore = stub.restore;
    const r = await resolveDidKeys(THIRD_DID, { baseUrl: BASE, resolverUrl: resolver });
    expect(r.source).toBe("did:web");
    expect(stub.asked).toEqual([STANDARD_THIRD]);
  });

  it("a non-did:web identifier resolves to nothing without a resolver", async () => {
    const stub = stubFetch({});
    restore = stub.restore;
    const r = await resolveDidKeys("did:key:z6Mk", { baseUrl: BASE });
    expect(r.keys).toEqual([]);
    expect(stub.asked).toEqual([]);
    expect(r.detail).toContain("not a did:web");
  });
});
