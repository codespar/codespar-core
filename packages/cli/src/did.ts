/**
 * did:web resolution for the network verify path. Fetches an agent / issuer DID
 * document and extracts its raw Ed25519 public keys so the codec can verify a
 * presentation token's signatures.
 *
 * The standard did:web URL mapping is the authority for every DID. Two other
 * sources exist, and each is scoped:
 *
 *   - the API's `/v1/agents/<did>/did.json` route (the base URL the CLI is
 *     configured with) is consulted only for a DID whose host is one of the
 *     deployment's identity hosts — an explicit list, never derived from the
 *     base URL's domain labels — and only when the standard document could
 *     not be fetched. A DID under another host never falls back there: a
 *     runtime must not become the authority over an identity it does not own.
 *   - an explicit resolver (`--resolver <url>`) is consulted for any DID whose
 *     standard document could not be fetched. It is opt-in and additive: a
 *     miss there still falls through to the identity-host rule. The result
 *     says where the keys came from so the caller can say so too.
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

/** A did:web host segment after decoding: letters, digits, `.`/`-`, optional port. */
const HOST_RE = /^[a-z0-9.-]+(:\d+)?$/;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * The host of a `did:web` identifier: the first segment, percent-decoded,
 * lowercased, validated as a bare host (a decoded `/`, `@`, `?` or the like
 * is rejected — `did:web:evil.example%2F.trusted.example` names no host), and
 * returned without its port. Null for a non-did:web or malformed input.
 */
export function didWebHost(did: string): string | null {
  return didWebParts(did)?.host ?? null;
}

interface DidWebParts {
  /** Host without port. */
  host: string;
  /** Host with the decoded `%3A` port, for the URL. */
  authority: string;
  path: string[];
}

function didWebParts(did: string): DidWebParts | null {
  if (!did.startsWith("did:web:")) return null;
  const rest = did.slice("did:web:".length);
  if (rest.length === 0) return null;
  const segments = rest.split(":");
  const first = decodeSegment(segments[0]!);
  if (first === null) return null;
  const authority = first.toLowerCase();
  if (!HOST_RE.test(authority)) return null;
  const path: string[] = [];
  for (const seg of segments.slice(1)) {
    const decoded = decodeSegment(seg);
    if (decoded === null || decoded.length === 0 || decoded.includes("/")) return null;
    path.push(decoded);
  }
  return { host: authority.replace(/:\d+$/, ""), authority, path };
}

/**
 * Map a `did:web` identifier to its standard document URL.
 *   did:web:id.codespar.dev            → https://id.codespar.dev/.well-known/did.json
 *   did:web:id.codespar.dev:org:agent  → https://id.codespar.dev/org/agent/did.json
 * Colon-separated path segments become URL path segments; a `%3A` in the domain
 * segment decodes to a port. Returns null for a non-did:web input, a malformed
 * percent-encoding, or a host segment that decodes to something other than a
 * host.
 */
export function didWebToUrl(did: string): string | null {
  const parts = didWebParts(did);
  if (!parts) return null;
  if (parts.path.length === 0) {
    return `https://${parts.authority}/.well-known/did.json`;
  }
  return `https://${parts.authority}/${parts.path.map(encodeURIComponent).join("/")}/did.json`;
}

/**
 * The `/v1/agents/<did>/did.json` route under a base URL. The base may carry
 * a path; a trailing `/v1` is not doubled (`https://x/v1` → `https://x/v1/agents/…`).
 */
export function apiFallbackUrl(did: string, baseUrl: string): string {
  const u = new URL(baseUrl);
  let path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -"/v1".length);
  return `${u.origin}${path}/v1/agents/${encodeURIComponent(did)}/did.json`;
}

/** The base URL the CLI ships pointed at, whose identity host is known. */
export const DEFAULT_BASE_URL = "https://api.codespar.dev";
const DEFAULT_IDENTITY_HOST = "id.codespar.dev";

/**
 * The hosts whose DID documents the API at `baseUrl` may serve: the API's own
 * host, exactly; `id.codespar.dev` only when the base URL is the shipped
 * default; and whatever the caller configured (`--did-domain`). Nothing is
 * derived from domain labels — with `https://runtime.com.br` that would make
 * every `did:web:*.com.br` the runtime's own.
 */
export function identityHosts(baseUrl: string, configured: string[] = []): string[] {
  const hosts = new Set<string>();
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host) hosts.add(host);
    if (host === new URL(DEFAULT_BASE_URL).hostname) hosts.add(DEFAULT_IDENTITY_HOST);
  } catch {
    // An unparseable base URL answers for nothing.
  }
  for (const h of configured) {
    const v = h.trim().toLowerCase();
    if (v) hosts.add(v);
  }
  return [...hosts];
}

/**
 * Whether the API at `baseUrl` may serve `did`'s document: the DID's host
 * equals one of the identity hosts or sits under one at a label boundary.
 * Anything else is a third-party identity the API is not an authority on.
 */
export function isOwnDid(did: string, baseUrl: string, didDomains: string[] = []): boolean {
  const host = didWebHost(did);
  if (!host) return false;
  return identityHosts(baseUrl, didDomains).some((h) => host === h || host.endsWith(`.${h}`));
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
  /** API base URL; its DID route serves only the deployment's identity hosts. */
  baseUrl?: string;
  /** Preferred verificationMethod id — sorted to the front of the result. */
  preferredKid?: string;
  timeoutMs?: number;
  /**
   * Explicit resolver base URL. Its `/v1/agents/<did>/did.json` route is
   * consulted for ANY DID whose standard did:web document could not be
   * fetched. Opt-in and additive: a miss falls through to the identity-host
   * rule.
   */
  resolverUrl?: string;
  /** Identity hosts the API's DID route may serve, beyond the built-in ones. */
  didDomains?: string[];
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
 * fetched at all, the explicit resolver when one is given; then the API's own
 * route when the DID is under one of the deployment's identity hosts. A
 * fetched standard document without keys ends the resolution with no keys.
 * Keys matching `preferredKid` are ordered first so the caller can verify
 * against the exact signing key when the token names one.
 */
export async function resolveDidKeys(
  did: string,
  opts: ResolveOptions = {},
): Promise<DidResolution> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
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
  const keysAt = async (url: string): Promise<DidKey[]> => {
    tried.push(url);
    const fetched = await fetchDocument(url, timeoutMs);
    return fetched.kind === "document" ? keysFromDocument(fetched.doc) : [];
  };

  const standard = didWebToUrl(did);
  if (!standard) {
    if (!did.startsWith("did:web:")) return none(`${did} is not a did:web identifier`);
    return none(`${did} is not a well-formed did:web identifier`);
  }

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

  if (opts.resolverUrl) {
    const url = apiFallbackUrl(did, opts.resolverUrl);
    const keys = await keysAt(url);
    if (keys.length > 0) return found("resolver", keys, url);
  }

  if (isOwnDid(did, baseUrl, opts.didDomains)) {
    const url = apiFallbackUrl(did, baseUrl);
    const keys = await keysAt(url);
    if (keys.length > 0) return found("fallback", keys, url);
    return none(`none of ${tried.join(", ")} returned a document with an Ed25519 key`);
  }

  const host = didWebHost(did) ?? did;
  const hosts = identityHosts(baseUrl, opts.didDomains).join(", ");
  const resolverNote = opts.resolverUrl
    ? `the resolver returned no document with an Ed25519 key; `
    : `pass --resolver <url> to opt into a resolver; `;
  return none(
    `the DID document at ${standard} could not be fetched; ${resolverNote}` +
      `${host} is not one of this deployment's identity hosts (${hosts}), so the API was not ` +
      `consulted for it (--did-domain <host> declares one)`,
  );
}
