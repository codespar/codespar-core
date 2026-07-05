/**
 * did:web resolution for the network verify path. Fetches an agent / issuer DID
 * document and extracts its raw Ed25519 public keys so the codec can verify a
 * presentation token's signatures.
 *
 * Resolution order (per the rollout in progress): try the standard did:web URL
 * mapping first, then fall back to the api.codespar.dev encoded route that
 * serves the same document today.
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

/** The api.codespar.dev fallback route that serves the DID doc today. */
export function apiFallbackUrl(did: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/v1/agents/${encodeURIComponent(did)}/did.json`;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/did+json, application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
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
  /** Base URL for the api.codespar.dev fallback route (default the prod API). */
  baseUrl?: string;
  /** Preferred verificationMethod id — sorted to the front of the result. */
  preferredKid?: string;
  timeoutMs?: number;
}

/**
 * Resolve a `did:web` identifier to its Ed25519 public keys. Tries the standard
 * did:web URL, then the api.codespar.dev encoded fallback. Keys matching
 * `preferredKid` are ordered first so the caller can verify against the exact
 * signing key when the token names one. Returns [] if the document can't be
 * fetched or carries no Ed25519 keys.
 */
export async function resolveDidKeys(
  did: string,
  opts: ResolveOptions = {},
): Promise<DidKey[]> {
  const baseUrl = opts.baseUrl ?? "https://api.codespar.dev";
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const candidates: string[] = [];
  const standard = didWebToUrl(did);
  if (standard) candidates.push(standard);
  candidates.push(apiFallbackUrl(did, baseUrl));

  for (const url of candidates) {
    const doc = await fetchJson(url, timeoutMs);
    const keys = keysFromDocument(doc);
    if (keys.length > 0) {
      if (opts.preferredKid) {
        keys.sort((a, b) =>
          a.kid === opts.preferredKid ? -1 : b.kid === opts.preferredKid ? 1 : 0,
        );
      }
      return keys;
    }
  }
  return [];
}
