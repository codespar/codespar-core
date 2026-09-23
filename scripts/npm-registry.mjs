/**
 * The one way this repo's scripts read an npm package document.
 *
 * Honours NPM_CONFIG_REGISTRY. A 404 on the document means "never
 * published" and returns null — a real answer. Any other non-OK response,
 * or a network failure, is an unanswered question and throws RegistryError,
 * so a caller can tell "the registry is behind" from "the registry could
 * not be reached" and say which.
 */

export const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";

export class RegistryError extends Error {}

export function packageDocumentUrl(name) {
  return `${REGISTRY}/${name.replace("/", "%2f")}`;
}

/** The package document (`versions`, `dist-tags`, ...) or null on 404. */
export async function fetchPackageDocument(name) {
  const url = packageDocumentUrl(name);
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    const cause = err instanceof Error ? (err.cause ?? err) : err;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RegistryError(`could not reach the registry for ${name} (${url}): ${detail}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new RegistryError(`registry returned ${res.status} for ${name} (${url})`);
  return res.json();
}

/** Release versions (x.y.z, no prerelease) published for `name`; [] when never published. */
export async function publishedVersions(name) {
  const doc = await fetchPackageDocument(name);
  return doc ? Object.keys(doc.versions ?? {}) : [];
}
