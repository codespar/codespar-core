/**
 * did:web resolution for the network verify path. Fetches an agent / issuer DID
 * document and extracts its raw Ed25519 public keys so the codec can verify a
 * presentation token's signatures.
 *
 * The standard did:web URL mapping is the authority for every DID. Two other
 * sources exist, and each is scoped:
 *
 *   - the API's `/v1/agents/<did>/did.json` route (the base URL the CLI is
 *     configured with) is consulted only for a DID whose did:web host is the
 *     API's own domain, and only when the standard document could not be
 *     fetched. A DID under another domain never falls back there: a runtime
 *     must not become the authority over an identity it does not own.
 *   - an explicit resolver (`--resolver <url>`) is consulted for any DID whose
 *     standard document could not be fetched. It is opt-in, and the result
 *     says the keys came from a resolver so the caller can say so too.
 *
 * A standard document that was fetched but carries no Ed25519 key is the
 * domain owner's answer, not an absence: no other source is consulted.
 *
 * Zero runtime deps — global `fetch` and the standard library only. Kept out of
 * `mandate-codec.ts` so the offline verifier path stays pure and network-free.
 */

/** A raw Ed25519 key pulled from a DID document's verificationMethod. */
export interface DidKey {
  /** The verificationMethod id (`<did>#<n>`). */
  kid: string;
  /** Raw 32-byte Ed25519 public key. */
  pubkey: Buffer;
}

interface JsonWebKey2020 {
  id?: unknown;
  type?: unknown;
  publicKeyJwk?: { kty?: unknown; crv?: unknown; x?: unknown };
}

interface DidDocument {
  verificationMethod?: JsonWebKey2020[];
}

/**
 * Map a `did:web` identifier to its standard document URL.
 *   did:web:id.codespar.dev            → https://id.codespar.dev/.well-known/did.json
 *   did:web:id.codespar.dev:org:agent  → https://id.codespar.dev/org/agent/did.json
 * Colon-separated path segments become URL path segments; a `%3A` in the domain
 * segment decodes to a port. Returns null for a non-did:web input.
 */
export function didWebToUrl(did: string): string | null {
  if (!did.startsWith("did:web:")) return null;
  const rest = did.slice("did:web:".length);
  if (rest.length === 0) return null;
  const segments = rest.split(":");
  const domain = decodeURIComponent(segments[0]!);
  const path = segments.slice(1).map((s) => decodeURIComponent(s));
  if (path.length === 0) {
    return `https://${domain}/.well-known/did.json`;
  }
  return `https://${domain}/${path.join("/")}/did.json`;
}

/** The API route that serves a DID document by its full, url-encoded DID. */
export function apiFallbackUrl(did: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1/agents/${encodeURIComponent(did)}/did.json`;
}

/** The host segment of a did:web identifier, lowercased, without a port. */
export function didWebHost(did: string): string | null {
  if (!did.startsWith("did:web:")) return null;
  const first = did.slice("did:web:".length).split(":")[0] ?? "";
  if (first.length === 0) return null;
  const host = decodeURIComponent(first).toLowerCase();
  return host.replace(/:\d+$/, "");
}

/**
 * The domain a base URL answers for: its hostname, minus the first label when
 * there are three or more (`api.codespar.dev` → `codespar.dev`), so the API
 * host and the identity host of one deployment share a suffix.
 */
export function ownDomainSuffix(baseUrl: string): string | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.length === 0) return null;
  const labels = host.split(".");
  return labels.length >= 3 ? labels.slice(1).join(".") : host;
}

function hostUnder(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Whether the API at `baseUrl` may serve `did`'s document: the DID's host is
 * the API's own domain (or one of `extraSuffixes`). Anything else is a
 * third-party identity the API is not an authority on.
 */
export function isOwnDid(did: string, baseUrl: string, extraSuffixes: string[] = []): boolean {
  const host = didWebHost(did);
  if (!host) return false;
  const own = ownDomainSuffix(baseUrl);
  const suffixes = [...(own ? [own] : []), ...extraSuffixes.map((s) => s.toLowerCase())];
  return suffixes.some((suffix) => hostUnder(host, suffix));
}

type Fetched = { kind: "document"; doc: Record<string, unknown> } | { kind: "absent" };

/**
 * Fetch a DID document. "absent" covers a non-2xx status, a network or
 * timeout failure and a body that is not a JSON object; "document" is any
 * JSON object, keys or not — the distinction the caller needs to tell "the
 * domain did not answer" from "the domain answered without keys".
 */
async function fetchDocument(url: string, timeoutMs: number): Promise<Fetched> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/did+json, application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return { kind: "absent" };
    const doc = (await res.json()) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { kind: "absent" };
    return { kind: "document", doc: doc as Record<string, unknown> };
  } catch {
    return { kind: "absent" };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract every Ed25519 (OKP) key from a DID document's verificationMethod. */
function keysFromDocument(doc: unknown): DidKey[] {
  if (!doc || typeof doc !== "object") return [];
  const methods = (doc as DidDocument).verificationMethod;
  if (!Array.isArray(methods)) return [];
  const keys: DidKey[] = [];
  for (const m of methods) {
    const jwk = m?.publicKeyJwk;
    if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue;
    if (typeof jwk.x !== "string" || typeof m.id !== "string") continue;
    const pubkey = Buffer.from(jwk.x, "base64url");
    if (pubkey.length !== 32) continue;
    keys.push({ kid: m.id, pubkey });
  }
  return keys;
}

export interface ResolveOptions {
  /** API base URL; its DID route serves only DIDs under the API's own domain. */
  baseUrl?: string;
  /** Preferred verificationMethod id — sorted to the front of the result. */
  preferredKid?: string;
  timeoutMs?: number;
  /**
   * Explicit resolver base URL. Its `/v1/agents/<did>/did.json` route is
   * consulted for ANY DID whose standard did:web document could not be
   * fetched. Opt-in: without it a DID outside the API's domain has exactly
   * one source, its own domain.
   */
  resolverUrl?: string;
  /** Extra domain suffixes the API's DID route may serve, beyond its own. */
  fallbackSuffixes?: string[];
}

/** Where a resolution's keys came from. */
export type DidSource = "did:web" | "fallback" | "resolver";

export interface DidResolution {
  /** Ed25519 keys, `preferredKid` first when named; empty when unresolved. */
  keys: DidKey[];
  /** The source the keys came from; null when there are none. */
  source: DidSource | null;
  /** Where the keys came from, or why there are none — for the user. */
  detail: string;
  /** Every URL consulted, in order. */
  tried: string[];
}

/**
 * Resolve a `did:web` identifier to its Ed25519 public keys.
 *
 * Order: the standard did:web URL; then, only if that document could not be
 * fetched at all, the explicit resolver when one is given, else the API's own
 * route when the DID is under the API's domain. A fetched document without
 * keys ends the resolution with no keys. Keys matching `preferredKid` are
 * ordered first so the caller can verify against the exact signing key when
 * the token names one.
 */
export async function resolveDidKeys(
  did: string,
  opts: ResolveOptions = {},
): Promise<DidResolution> {
  const baseUrl = opts.baseUrl ?? "https://api.codespar.dev";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const tried: string[] = [];

  const ordered = (keys: DidKey[]): DidKey[] => {
    if (opts.preferredKid) {
      keys.sort((a, b) =>
        a.kid === opts.preferredKid ? -1 : b.kid === opts.preferredKid ? 1 : 0,
      );
    }
    return keys;
  };
  const found = (source: DidSource, keys: DidKey[], url: string): DidResolution => ({
    keys: ordered(keys),
    source,
    detail: `${keys.length} Ed25519 key(s) from ${url}`,
    tried,
  });
  const none = (detail: string): DidResolution => ({ keys: [], source: null, detail, tried });

  const standard = didWebToUrl(did);
  if (!standard && !opts.resolverUrl) {
    return none(`${did} is not a did:web identifier`);
  }

  if (standard) {
    tried.push(standard);
    const fetched = await fetchDocument(standard, timeoutMs);
    if (fetched.kind === "document") {
      const keys = keysFromDocument(fetched.doc);
      if (keys.length > 0) return found("did:web", keys, standard);
      return none(
        `the DID document at ${standard} carries no Ed25519 key — that is the domain's ` +
          `answer, so no other source was consulted`,
      );
    }
  }

  if (opts.resolverUrl) {
    const url = apiFallbackUrl(did, opts.resolverUrl);
    tried.push(url);
    const fetched = await fetchDocument(url, timeoutMs);
    const keys = fetched.kind === "document" ? keysFromDocument(fetched.doc) : [];
    if (keys.length > 0) return found("resolver", keys, url);
    return none(
      `the DID document at ${standard ?? "(no did:web URL)"} could not be fetched, and the ` +
        `resolver at ${url} returned no document with an Ed25519 key`,
    );
  }

  if (isOwnDid(did, baseUrl, opts.fallbackSuffixes)) {
    const url = apiFallbackUrl(did, baseUrl);
    tried.push(url);
    const fetched = await fetchDocument(url, timeoutMs);
    const keys = fetched.kind === "document" ? keysFromDocument(fetched.doc) : [];
    if (keys.length > 0) return found("fallback", keys, url);
    return none(
      `neither the DID document at ${standard} nor the API route at ${url} returned an ` +
        `Ed25519 key`,
    );
  }

  const host = didWebHost(did) ?? did;
  const own = ownDomainSuffix(baseUrl) ?? baseUrl;
  return none(
    `the DID document at ${standard} could not be fetched; ${host} is not under ${own}, ` +
      `so the API was not consulted for it (pass --resolver <url> to opt into a resolver)`,
  );
}
