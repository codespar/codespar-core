/**
 * The JSON Schema validator the converter is measured against: ajv with
 * ajv-formats in "fast" mode, draft-07 by default and 2020-12 for schemas
 * that use its keywords. `strict: false`, as a consumer of arbitrary MCP
 * schemas has to be. A schema ajv cannot compile is reported, not judged.
 */

import { createRequire } from "node:module";
import { KEYWORD_SUPPORT } from "../../keywords.js";

interface AjvLike {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown };
}
type AjvCtor = new (opts: object) => AjvLike;

const require = createRequire(import.meta.url);
const Ajv07 = (require("ajv") as { default: AjvCtor }).default;
const Ajv2020 = (require("ajv/dist/2020") as { default: AjvCtor }).default;
const addFormats = (require("ajv-formats") as { default: (a: AjvLike, o: object) => void }).default;

function instance(Ctor: AjvCtor): AjvLike {
  const ajv = new Ctor({ strict: false, allErrors: false, validateSchema: false });
  addFormats(ajv, { mode: "fast" });
  return ajv;
}
const ajv07 = instance(Ajv07);
const ajv2020 = instance(Ajv2020);

const DRAFT_2020 = new Set([
  "prefixItems",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "minContains",
  "maxContains",
  "$dynamicRef",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every keyword used in a schema position, recursively. */
export function keywordsIn(schema: unknown, out = new Set<string>()): Set<string> {
  if (!isObj(schema)) return out;
  for (const k of Object.keys(schema)) out.add(k);
  forEachSub(schema, (sub) => keywordsIn(sub, out));
  return out;
}

const MAP_POSITIONS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const ONE_POSITIONS = [
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "unevaluatedItems",
];
const LIST_POSITIONS = ["anyOf", "oneOf", "allOf", "prefixItems"];

function forEachSub(s: Record<string, unknown>, fn: (sub: unknown) => void): void {
  for (const k of MAP_POSITIONS) if (isObj(s[k])) Object.values(s[k] as object).forEach(fn);
  for (const k of ONE_POSITIONS) if (s[k] !== undefined) fn(s[k]);
  for (const k of LIST_POSITIONS) if (Array.isArray(s[k])) (s[k] as unknown[]).forEach(fn);
  if (Array.isArray(s.items)) s.items.forEach(fn);
  else if (s.items !== undefined) fn(s.items);
}

/** The schema with every advisory and marked keyword removed from every schema position. */
export function withoutLenient(schema: unknown): unknown {
  if (!isObj(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    const support = KEYWORD_SUPPORT[k];
    if (support === "advisory" || support === "marked") continue;
    if (MAP_POSITIONS.includes(k) && isObj(v)) {
      out[k] = Object.fromEntries(Object.entries(v).map(([n, sub]) => [n, withoutLenient(sub)]));
    } else if ((LIST_POSITIONS.includes(k) || k === "items") && Array.isArray(v)) {
      out[k] = v.map(withoutLenient);
    } else if (ONE_POSITIONS.includes(k) || k === "items") {
      out[k] = withoutLenient(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export type Judge = ((x: unknown) => boolean) | { skipped: string };

/** A validator for `schema`, or why ajv cannot judge it. */
export function judge(schema: Record<string, unknown>): Judge {
  const uses2020 = [...keywordsIn(schema)].some((k) => DRAFT_2020.has(k));
  try {
    const validate = (uses2020 ? ajv2020 : ajv07).compile(schema);
    return (x) => validate(x);
  } catch (err) {
    return { skipped: err instanceof Error ? err.message.split("\n")[0]!.slice(0, 120) : String(err) };
  }
}
