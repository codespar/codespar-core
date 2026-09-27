/**
 * `receipt-chain`: the receipt's `chain` recomputed from its body, the way a
 * party outside CodeSpar does it.
 *
 * The Ed25519 signature covers `codespar-receipt:v1:<id>:<chain>`, so on its
 * own it proves CodeSpar sealed SOME body with that digest. Recomputing the
 * digest from the receipt read is what binds THIS body — the payee, the
 * amount, and since chain v4 the approval hashes — to the signature. CodeSpar
 * publishes how, as data: `chain_recipe` on the unauthenticated
 * `/.well-known/codespar-receipt-keys.json` (ent#1670). This module reads that
 * recipe and applies it. It does not carry its own copy of the link shapes: a
 * recipe it does not understand is an answer ("cannot recompute"), never a
 * guess, because a verifier that silently skipped a clause would compute a
 * different digest and blame the receipt.
 *
 *   chain = hex(SHA-256(UTF-8(JCS({ "v": chain_version, "links": [...] }))))
 *
 * JCS is RFC 8785, implemented below in full rather than imported: it is
 * thirty lines, the enterprise's own canonicalizer is exactly the code a
 * verifier must not depend on, and a dependency would be one more thing to
 * audit for a third party who wants to reimplement this. Like
 * `receipt-verification`, it imports `node:crypto` and nothing else.
 */
import { createHash } from "node:crypto";

/* ── RFC 8785 ────────────────────────────────────────────────── */

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The JSON Canonicalization Scheme (RFC 8785) of a JSON value.
 *
 * - Objects: members sorted by their names as arrays of UTF-16 code units,
 *   which is what the default `Array.prototype.sort` compares (section 3.2.3).
 * - Numbers: the ECMAScript `Number.prototype.toString` serialization, which
 *   is what `JSON.stringify` emits for a finite number (section 3.2.2.3);
 *   NaN and the infinities are not JSON and are refused.
 * - Strings: `JSON.stringify`'s escaping, which is the RFC's (section
 *   3.2.2.2) — except that JCS works on I-JSON, where a lone surrogate is not
 *   a string at all, so one is refused instead of escaped.
 * - No whitespace anywhere.
 *
 * `undefined`, functions and other non-JSON values are refused: canonicalizing
 * something that is not JSON would hash a value nobody can reproduce.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`RFC 8785: ${value} is not a JSON number`);
      return JSON.stringify(value);
    case "string":
      if (LONE_SURROGATE.test(value)) throw new TypeError("RFC 8785: a string with a lone surrogate is not I-JSON");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const members = Object.keys(value as Record<string, unknown>).sort();
      return `{${members
        .map((name) => {
          if (LONE_SURROGATE.test(name)) throw new TypeError("RFC 8785: a member name with a lone surrogate is not I-JSON");
          return `${JSON.stringify(name)}:${canonicalize((value as Record<string, unknown>)[name])}`;
        })
        .join(",")}}`;
    }
    default:
      throw new TypeError(`RFC 8785: a ${typeof value} is not a JSON value`);
  }
}

/* ── The published recipe ────────────────────────────────────── */

/** One link of the recipe, as `chain_recipe.links[]` publishes it. */
export interface ChainRecipeLink {
  link: string;
  /** The member of the receipt read the link's fields are taken from. */
  from: string;
  /** When the link is part of the chain: a clause from a small published vocabulary. */
  when: string;
  fields?: string[];
  fields_by_version?: Record<string, string[]>;
}

export interface ChainRecipe {
  canonicalization: string;
  digest: string;
  version: { field: string; rule?: string };
  /** The suffix that marks a field included only when the read has it and it is not null. */
  optional_marker: string;
  links: ChainRecipeLink[];
}

/** The canonicalization this module implements, spelled as the recipe spells it. */
export const RECIPE_CANONICALIZATION = "RFC 8785 (JCS)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export type RecipeRead = { ok: true; recipe: ChainRecipe } | { ok: false; reason: "recipe_unpublished" | "recipe_unrecognized"; message: string };

/**
 * The `chain_recipe` of a key document, or why there is none this module can
 * follow. A document without one comes from a deployment older than ent#1670:
 * nothing is wrong with the receipt, there is just no published way to bind
 * its body. A recipe whose canonicalization or digest is not the one
 * implemented here is refused whole rather than followed halfway.
 */
export function readChainRecipe(keyDocument: unknown): RecipeRead {
  // OUTSIDE THE SDK'S TYPES, and the one place it is read: the well-known
  // document's schema does not declare `chain_recipe` yet (ent#1759), so no
  // SDK type exists to read it through. It is validated field by field below
  // instead. When ent#1759 lands and the SDK types it, this read moves onto
  // that type and the validation stays: a verifier checks what it is served.
  const raw = isRecord(keyDocument) ? keyDocument["chain_recipe"] : undefined;
  if (raw === undefined || raw === null) {
    return { ok: false, reason: "recipe_unpublished", message: "the key set publishes no `chain_recipe`, so the receipt's body cannot be bound to its chain (a deployment older than ent#1670)" };
  }
  const unrecognized = (why: string): RecipeRead => ({ ok: false, reason: "recipe_unrecognized", message: `the published \`chain_recipe\` ${why}, so this verifier does not follow it` });
  if (!isRecord(raw)) return unrecognized("is not an object");
  if (raw["canonicalization"] !== RECIPE_CANONICALIZATION) return unrecognized(`names the canonicalization ${JSON.stringify(raw["canonicalization"])}, not ${RECIPE_CANONICALIZATION}`);
  const digest = raw["digest"];
  if (typeof digest !== "string" || !/\bSHA-256\b/.test(digest) || !/\blowercase hex\b/.test(digest)) return unrecognized(`names the digest ${JSON.stringify(digest)}, not lowercase-hex SHA-256`);
  const version = raw["version"];
  if (!isRecord(version) || typeof version["field"] !== "string") return unrecognized("does not name the field that carries the chain version");
  const marker = raw["optional_marker"];
  if (typeof marker !== "string" || marker.length === 0) return unrecognized("does not name its optional-field marker");
  const links = raw["links"];
  if (!Array.isArray(links) || links.length === 0) return unrecognized("lists no links");
  const parsed: ChainRecipeLink[] = [];
  for (const entry of links) {
    if (!isRecord(entry) || typeof entry["link"] !== "string" || typeof entry["from"] !== "string" || typeof entry["when"] !== "string") return unrecognized("carries a link without `link`, `from` and `when`");
    const fields = entry["fields"];
    const byVersion = entry["fields_by_version"];
    if (fields !== undefined && !isStringArray(fields)) return unrecognized(`gives the link ${entry["link"]} fields that are not a list of names`);
    if (byVersion !== undefined && !(isRecord(byVersion) && Object.values(byVersion).every(isStringArray))) return unrecognized(`gives the link ${entry["link"]} per-version fields that are not lists of names`);
    if (fields === undefined && byVersion === undefined) return unrecognized(`gives the link ${entry["link"]} no fields`);
    parsed.push({
      link: entry["link"],
      from: entry["from"],
      when: entry["when"],
      ...(fields !== undefined ? { fields } : {}),
      ...(byVersion !== undefined ? { fields_by_version: byVersion as Record<string, string[]> } : {}),
    });
  }
  return {
    ok: true,
    recipe: {
      canonicalization: RECIPE_CANONICALIZATION,
      digest,
      version: { field: version["field"], ...(typeof version["rule"] === "string" ? { rule: version["rule"] } : {}) },
      optional_marker: marker,
      links: parsed,
    },
  };
}

/* ── Recomputing ─────────────────────────────────────────────── */

export type ChainRecomputation =
  | { ok: true; chain: string; version: number }
  | {
      ok: false;
      /**
       * `chain_version_missing`  the read does not say which version sealed it.
       * `recipe_unrecognized`    a clause, or a version, the recipe does not
       *                          define in a way this module can follow.
       * `mandate_sig_required`   a v1–v3 chain seals the mandate's raw
       *                          signature, which the read given here does
       *                          not carry.
       * `payee_masked`           the quote's payee is a masked copy; the chain
       *                          sealed the key itself.
       * `field_missing`          any other field the recipe needs is absent.
       */
      reason: "chain_version_missing" | "recipe_unrecognized" | "mandate_sig_required" | "payee_masked" | "field_missing";
      message: string;
      version: number | null;
    };

/** A payee the proof bundle masked (`es***@exemplo.com.br`). No Pix key contains `***`. */
export function isMaskedPayee(payee: unknown): boolean {
  return typeof payee === "string" && payee.includes("***");
}

/** Whether a link applies. `undefined` for a clause the recipe did not publish before this module was written. */
function applies(when: string, from: string, read: Record<string, unknown>, version: number): boolean | undefined {
  if (when === "always") return true;
  if (when === `${from} is not null`) return read[from] !== null && read[from] !== undefined;
  const byVersion = /^chain_version is (\d+)$/.exec(when);
  if (byVersion) return version === Number(byVersion[1]);
  return undefined;
}

/**
 * Recompute `chain` from a receipt read (the JSON of
 * `GET /v1/consumers/receipts/{id}`), following the recipe exactly: links in
 * the published order, a link whose clause does not hold left out rather than
 * nulled, values copied as read (`null` included), a field marked optional
 * included only when present and not null. Timestamps are taken as read: the
 * API seals them in the form it reads them back (RFC 3339 UTC, milliseconds).
 *
 * This is the pure recomputation, for any version. Whether a verifier SHOULD
 * recompute a given version is policy, and lives in `verifyReceiptRead`.
 */
export function recomputeChain(read: Record<string, unknown>, recipe: ChainRecipe): ChainRecomputation {
  const versionRaw = read[recipe.version.field];
  if (typeof versionRaw !== "number" || !Number.isSafeInteger(versionRaw) || versionRaw < 1) {
    return { ok: false, reason: "chain_version_missing", version: null, message: `the read carries no \`${recipe.version.field}\`, so which links were sealed cannot be known` };
  }
  const version = versionRaw;
  const links: Record<string, unknown>[] = [];
  for (const spec of recipe.links) {
    const include = applies(spec.when, spec.from, read, version);
    if (include === undefined) return { ok: false, reason: "recipe_unrecognized", version, message: `the recipe includes the link ${spec.link} "when ${spec.when}", a clause this verifier does not know` };
    if (!include) continue;
    const fields = spec.fields ?? spec.fields_by_version?.[String(version)];
    if (!fields) return { ok: false, reason: "recipe_unrecognized", version, message: `the recipe gives the link ${spec.link} no fields for chain v${version}` };
    const source = read[spec.from];
    if (!isRecord(source)) return { ok: false, reason: "field_missing", version, message: `the read carries no \`${spec.from}\` object, which the ${spec.link} link of a v${version} chain is taken from` };
    const link: Record<string, unknown> = {};
    for (const field of fields) {
      const optional = field.endsWith(recipe.optional_marker);
      const name = optional ? field.slice(0, -recipe.optional_marker.length) : field;
      const value = source[name];
      if (optional) {
        if (value !== undefined && value !== null) link[name] = value;
        continue;
      }
      if (value === undefined) {
        if (spec.from === "mandate" && name === "sig") {
          return { ok: false, reason: "mandate_sig_required", version, message: `chain v${version} seals the mandate's own signature, and the read carries none: it is a bearer proof only the tenant holds` };
        }
        return { ok: false, reason: "field_missing", version, message: `the read carries no \`${spec.from}.${name}\`, which the ${spec.link} link of a v${version} chain seals` };
      }
      if (spec.from === "quote" && name === "payee" && isMaskedPayee(value)) {
        return { ok: false, reason: "payee_masked", version, message: "the quote's payee is a masked copy; the chain sealed the key itself, so this body cannot be recomputed from it" };
      }
      link[name] = value;
    }
    links.push(link);
  }
  return { ok: true, version, chain: createHash("sha256").update(canonicalize({ v: version, links }), "utf8").digest("hex") };
}

/* ── The approval link (chain v4) ────────────────────────────── */

export interface SealedApproval {
  items_hash: string;
  batch_hash: string | null;
}

/** The approval a read says was sealed, or `null` when it carries none (every chain before v4). */
export function readSealedApproval(read: Record<string, unknown>): SealedApproval | null {
  const approval = read["approval"];
  if (!isRecord(approval) || typeof approval["items_hash"] !== "string") return null;
  const batch = approval["batch_hash"];
  return { items_hash: approval["items_hash"], batch_hash: typeof batch === "string" ? batch : null };
}

/** Two spellings of one SHA-256: the API seals the value as sent, and the `sha256:` prefix is optional on the wire. */
export function sameApprovalHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const bare = (h: string | null | undefined) => (typeof h === "string" ? h.replace(/^sha256:/, "") : null);
  return bare(a) === bare(b);
}
