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

/** The base URL the CLI ships pointed at, whose identity host is known. */
export const DEFAULT_BASE_URL = "https://api.codespar.dev";
const DEFAULT_IDENTITY_HOST = "id.codespar.dev";

/** A configuration value this module cannot work with: a URL or host that is not one. */
export class DidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DidConfigError";
  }
}

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

/** A host: a DNS name or a bracketed IPv6 literal. No port, no path. */
const HOST_RE = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])$/;
/** A did:web host segment after decoding: a host with an optional port. */
const AUTHORITY_RE = /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d+)?$/;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** The validated parts of a `did:web` identifier. */
export interface DidWebParts {
  /** Host without port, lowercased (`[::1]` for an IPv6 literal). */
  host: string;
  /** Host with the decoded `%3A` port, for the URL. */
  authority: string;
  /** The host segment exactly as written in the DID, for deriving sibling DIDs. */
  hostSegment: string;
  path: string[];
}

/**
 * Parse and validate a `did:web` identifier. The first segment must
 * percent-decode to a host with an optional port (a decoded `/`, `@`, `?` or
 * the like is rejected — `did:web:evil.example%2F.trusted.example` names no
 * host); every path segment must decode to a non-empty name that is not `.`
 * or `..` and carries no `/`, so no DID maps to a URL outside its own path.
 * Null for a non-did:web or malformed input, including invalid
 * percent-encoding.
 */
export function didWebParts(did: string): DidWebParts | null {
  if (!did.startsWith("did:web:")) return null;
  const rest = did.slice("did:web:".length);
  if (rest.length === 0) return null;
  const segments = rest.split(":");
  const hostSegment = segments[0]!;
  const first = decodeSegment(hostSegment);
  if (first === null) return null;
  const authority = first.toLowerCase();
  if (!AUTHORITY_RE.test(authority)) return null;
  const path: string[] = [];
  for (const seg of segments.slice(1)) {
    const decoded = decodeSegment(seg);
    if (decoded === null || decoded.length === 0 || decoded === "." || decoded === "..") {
      return null;
    }
    if (decoded.includes("/")) return null;
    path.push(decoded);
  }
  return { host: authority.replace(/:\d+$/, ""), authority, hostSegment, path };
}

/** The host of a `did:web` identifier (see {@link didWebParts}); null when malformed. */
export function didWebHost(did: string): string | null {
  return didWebParts(did)?.host ?? null;
}

/**
 * Map a `did:web` identifier to its standard document URL.
 *   did:web:id.codespar.dev            → https://id.codespar.dev/.well-known/did.json
 *   did:web:id.codespar.dev:org:agent  → https://id.codespar.dev/org/agent/did.json
 * Colon-separated path segments become URL path segments; a `%3A` in the domain
 * segment decodes to a port. Returns null for a non-did:web or malformed input
 * (see {@link didWebParts}).
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
 * Parse a base URL the way the rest of the CLI does: only its origin counts,
 * a path on it is ignored. Throws {@link DidConfigError} when it is not an
 * absolute http(s) URL.
 */
export function parseBaseUrl(raw: string, what = "base URL"): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DidConfigError(`${what} must be an absolute http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new DidConfigError(`${what} must be an http(s) URL, got ${u.protocol}//`);
  }
  return u;
}

/**
 * The `/v1/agents/<did>/did.json` route at a base URL's origin. A path on the
 * base URL is ignored, as every other CLI request ignores it.
 */
export function apiFallbackUrl(did: string, baseUrl: string): string {
  const origin = parseBaseUrl(baseUrl).origin;
  return `${origin}/v1/agents/${encodeURIComponent(did)}/did.json`;
}

/**
 * Normalise a configured identity host: a bare host or a URL, lowercased,
 * without scheme, port, path or trailing slash. Throws {@link DidConfigError}
 * when what remains is not a host.
 */
export function parseIdentityHost(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw new DidConfigError(`identity host must be a host or URL, got ${JSON.stringify(raw)}`);
    }
  } else {
    value = value.replace(/\/.*$/, "");
    if (!value.startsWith("[")) value = value.replace(/:\d+$/, "");
    else value = value.replace(/\](:\d+)?$/, "]");
  }
  if (!HOST_RE.test(value)) {
    throw new DidConfigError(`identity host must be a host or URL, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * The hosts whose DID documents the API at `baseUrl` may serve: the API's own
 * host, exactly; `id.codespar.dev` only when the base URL is the shipped
 * default; and whatever the caller configured (`--did-domain`, config
 * `didDomains`). Nothing is derived from domain labels — with
 * `https://runtime.com.br` that would make every `did:web:*.com.br` the
 * runtime's own. Throws {@link DidConfigError} on a base URL or configured
 * host it cannot parse.
 */
export function identityHosts(baseUrl: string, configured: string[] = []): string[] {
  const hosts = new Set<string>();
  const host = parseBaseUrl(baseUrl).hostname.toLowerCase();
  hosts.add(host);
  if (host === new URL(DEFAULT_BASE_URL).hostname) hosts.add(DEFAULT_IDENTITY_HOST);
  for (const h of configured) hosts.add(parseIdentityHost(h));
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

type Outcome = "unreachable" | "keyless";

function describe(what: string, url: string, outcome: Outcome): string {
  return outcome === "unreachable"
    ? `${what} at ${url} could not be fetched`
    : `${what} at ${url} answered a document with no Ed25519 key`;
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
 *
 * Throws {@link DidConfigError} before any request when `baseUrl`,
 * `resolverUrl` or a configured identity host cannot be parsed.
 */
export async function resolveDidKeys(
  did: string,
  opts: ResolveOptions = {},
): Promise<DidResolution> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const hosts = identityHosts(baseUrl, opts.didDomains);
  if (opts.resolverUrl !== undefined) parseBaseUrl(opts.resolverUrl, "resolver URL");
  const tried: string[] = [];
  const reasons: string[] = [];

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
  const none = (extra?: string): DidResolution => ({
    keys: [],
    source: null,
    detail: [...reasons, ...(extra ? [extra] : [])].join("; "),
    tried,
  });
  const consult = async (
    what: string,
    url: string,
  ): Promise<{ keys: DidKey[]; outcome: Outcome | "keys" }> => {
    tried.push(url);
    const fetched = await fetchDocument(url, timeoutMs);
    if (fetched.kind === "absent") {
      reasons.push(describe(what, url, "unreachable"));
      return { keys: [], outcome: "unreachable" };
    }
    const keys = keysFromDocument(fetched.doc);
    if (keys.length === 0) {
      reasons.push(describe(what, url, "keyless"));
      return { keys, outcome: "keyless" };
    }
    return { keys, outcome: "keys" };
  };

  const standard = didWebToUrl(did);
  if (!standard) {
    reasons.push(
      did.startsWith("did:web:")
        ? `${did} is not a well-formed did:web identifier`
        : `${did} is not a did:web identifier`,
    );
    return none();
  }

  const primary = await consult("the DID document", standard);
  if (primary.outcome === "keys") return found("did:web", primary.keys, standard);
  if (primary.outcome === "keyless") {
    return none("that is the domain's answer, so no other source was consulted");
  }

  if (opts.resolverUrl !== undefined) {
    const url = apiFallbackUrl(did, opts.resolverUrl);
    const viaResolver = await consult("the resolver", url);
    if (viaResolver.outcome === "keys") return found("resolver", viaResolver.keys, url);
  }

  if (isOwnDid(did, baseUrl, opts.didDomains)) {
    const url = apiFallbackUrl(did, baseUrl);
    const viaApi = await consult("the API route", url);
    if (viaApi.outcome === "keys") return found("fallback", viaApi.keys, url);
    return none();
  }

  const host = didWebHost(did) ?? did;
  return none(
    `${host} is not one of this deployment's identity hosts (${hosts.join(", ")}), so the API ` +
      `was not consulted for it` +
      (opts.resolverUrl === undefined
        ? ` (--resolver <url> opts into a resolver; --did-domain <host> declares an identity host)`
        : ` (--did-domain <host> declares an identity host)`),
  );
}
