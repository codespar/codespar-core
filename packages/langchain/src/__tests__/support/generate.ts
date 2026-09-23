/**
 * Candidate inputs for a JSON Schema, derived mechanically from the schema:
 * a canonical value per node, then mutants around every constraint. The
 * generator does not decide validity — the JSON Schema validator does — so
 * it only has to reach the boundaries.
 */

type Schema = Record<string, unknown> | boolean | undefined;

const WRONG_TYPES: unknown[] = [null, 0, 1.5, "s", true, [], {}];
const MAX_PER_NODE = 36;
const MAX_DEPTH = 5;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function resolve(ref: string, root: Record<string, unknown>): Schema {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = isObj(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
  }
  return isObj(node) ? node : undefined;
}

function dedupe(values: unknown[], cap: number): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of values) {
    const k = JSON.stringify(v);
    if (k === undefined || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

const FORMAT_SAMPLES: Record<string, unknown[]> = {
  email: ["a@b.co", "not-an-email", '"a b"@x.co'],
  "date-time": ["2026-09-23T12:00:00Z", "2026-09-23t12:00:00z", "yesterday"],
  date: ["2026-09-23", "2026-13-40", "23/09/2026"],
  uri: ["https://x.example/p", "urn:isbn:0451450523", "not a uri"],
  url: ["https://x.example/p", "not a url"],
  uuid: ["123e4567-e89b-12d3-a456-426614174000", "not-a-uuid"],
};

function types(s: Record<string, unknown>): string[] {
  if (Array.isArray(s.type)) return s.type.filter((t): t is string => typeof t === "string");
  if (typeof s.type === "string") return [s.type];
  // Without `type`, every keyword present names a kind worth exercising.
  const out: string[] = [];
  if (isObj(s.properties) || Array.isArray(s.required) || s.additionalProperties !== undefined) out.push("object");
  if (["items", "prefixItems", "minItems", "maxItems", "uniqueItems"].some((k) => s[k] !== undefined)) out.push("array");
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((k) => s[k] !== undefined)) out.push("number");
  if (["minLength", "maxLength", "pattern", "format"].some((k) => s[k] !== undefined)) out.push("string");
  return out;
}

function strings(s: Record<string, unknown>): unknown[] {
  const min = typeof s.minLength === "number" ? s.minLength : 0;
  const max = typeof s.maxLength === "number" ? s.maxLength : undefined;
  const len = Math.max(min, 1);
  let base = "a".repeat(max !== undefined ? Math.min(len, max) : len);
  if (typeof s.pattern === "string") {
    const lead = /^\^([A-Za-z0-9_-]+)/.exec(s.pattern);
    if (lead) base = lead[1] + base;
  }
  const fmt = typeof s.format === "string" ? FORMAT_SAMPLES[s.format] ?? [] : [];
  const out = [...fmt.slice(0, 1), base, "", "a".repeat(Math.max(min - 1, 0)), "A1"];
  if (max !== undefined) out.push("a".repeat(max), "a".repeat(max + 1));
  // Astral characters at the bounds: JSON Schema counts code points, not UTF-16 units.
  const astral = "\u{1F600}";
  out.push(astral, astral.repeat(Math.max(min - 1, 0)), astral.repeat(Math.max(min, 1)));
  if (max !== undefined) out.push(astral.repeat(max), astral.repeat(max + 1));
  out.push(...fmt.slice(1));
  return out;
}

function numbers(s: Record<string, unknown>, integer: boolean): unknown[] {
  const out: number[] = [];
  const lo = typeof s.minimum === "number" ? s.minimum : undefined;
  const hi = typeof s.maximum === "number" ? s.maximum : undefined;
  const xlo = typeof s.exclusiveMinimum === "number" ? s.exclusiveMinimum : undefined;
  const xhi = typeof s.exclusiveMaximum === "number" ? s.exclusiveMaximum : undefined;
  const m = typeof s.multipleOf === "number" ? s.multipleOf : undefined;
  let base = lo ?? (xlo !== undefined ? xlo + 1 : 1);
  if (m !== undefined) base = Math.ceil(base / m) * m;
  out.push(base);
  for (const b of [lo, hi, xlo, xhi]) if (b !== undefined) out.push(b, b - 1, b + 1, b + 0.5);
  if (m !== undefined) out.push(m * 2, m * 2 + 1, m / 2);
  out.push(0, -1, 1.5, 2);
  return integer ? [...out.filter(Number.isInteger), 2.5] : out;
}

function arrays(s: Record<string, unknown>, root: Record<string, unknown>, depth: number): unknown[] {
  const prefix = Array.isArray(s.prefixItems)
    ? (s.prefixItems as Schema[])
    : Array.isArray(s.items)
      ? (s.items as Schema[])
      : [];
  const restSchema = Array.isArray(s.items) ? (s.additionalItems as Schema) : prefix.length ? (s.items as Schema) : (s.items as Schema);
  const pre = prefix.map((p) => gen(p, root, depth + 1));
  const rest = restSchema === false ? [] : gen(restSchema, root, depth + 1);
  const r0 = rest[0] ?? "x";
  const r1 = rest[1] ?? 2;
  const min = typeof s.minItems === "number" ? s.minItems : 0;
  const max = typeof s.maxItems === "number" ? s.maxItems : undefined;
  const head = pre.map((c) => c[0]);
  const base = [...head];
  while (base.length < Math.max(min, head.length ? 0 : 1)) base.push(base.length % 2 ? r1 : r0);
  const out: unknown[] = [base, [], [r0], [r0, r1], [r0, r0], [...head, r0]];
  if (pre.length > 1) out.push(head.slice(0, 1), [...head].reverse());
  pre.forEach((c, i) => c.slice(1, 4).forEach((v) => out.push(head.map((h, j) => (j === i ? v : h)))));
  rest.slice(1, 5).forEach((v) => out.push([...head, v]));
  if (max !== undefined) out.push(Array.from({ length: max + 1 }, (_, i) => (i % 2 ? r1 : r0)));
  if (min > 0) out.push(Array.from({ length: min - 1 }, () => r0));
  return out;
}

function objects(s: Record<string, unknown>, root: Record<string, unknown>, depth: number): unknown[] {
  const props = isObj(s.properties) ? (s.properties as Record<string, Schema>) : {};
  const required = (Array.isArray(s.required) ? s.required : []).filter((k): k is string => typeof k === "string");
  const cands = Object.fromEntries(Object.entries(props).map(([k, p]) => [k, gen(p, root, depth + 1)]));
  const canon: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(cands)) if (c.length) canon[k] = c[0];
  for (const k of required) if (!(k in canon)) canon[k] = "x";
  const reqOnly = Object.fromEntries(required.map((k) => [k, canon[k]]));
  const out: unknown[] = [canon, reqOnly, {}, { ...canon, __extra__: "x" }, { ...canon, __extra__: 1 }];
  for (const k of required) {
    const { [k]: _gone, ...rest } = canon;
    out.push(rest);
  }
  for (const [k, c] of Object.entries(cands).slice(0, 14)) {
    for (const v of [...c.slice(1, 6), ...WRONG_TYPES]) out.push({ ...canon, [k]: v });
    out.push({ ...reqOnly, [k]: c[0] });
  }
  return out;
}

const MAX_REF_EXPANSIONS = 2;
let refExpansions = 0;
const memo = new WeakMap<object, Map<string, unknown[]>>();

/** Candidate values for `schema` (boolean schemas included), canonical first. */
export function gen(schema: Schema, root: Record<string, unknown>, depth = 0): unknown[] {
  if (schema === undefined || schema === true) return ["any", 1];
  if (schema === false) return [1];
  if (depth > MAX_DEPTH) return [null];
  const key = `${depth}:${refExpansions}`;
  const cached = memo.get(schema)?.get(key);
  if (cached) return cached;
  const result = genUncached(schema, root, depth);
  if (!memo.has(schema)) memo.set(schema, new Map());
  memo.get(schema)!.set(key, result);
  return result;
}

function genUncached(s: Record<string, unknown>, root: Record<string, unknown>, depth: number): unknown[] {
  const out: unknown[] = [];
  if (typeof s.$ref === "string") {
    // Recursive definitions are followed a bounded number of times.
    if (refExpansions < MAX_REF_EXPANSIONS) {
      refExpansions++;
      try {
        out.push(...gen(resolve(s.$ref, root), root, depth + 1));
      } finally {
        refExpansions--;
      }
    } else {
      out.push({}, null);
    }
  }
  if (s.const !== undefined) out.push(s.const, "__other__");
  if (Array.isArray(s.enum)) out.push(...s.enum, "__not_in_enum__");
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(s[key])) for (const b of s[key] as Schema[]) out.push(...gen(b, root, depth + 1).slice(0, 8));
  }
  if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as Schema[]).map((b) => gen(b, root, depth + 1));
    const firsts = parts.map((p) => p[0]);
    if (firsts.every(isObj)) out.push(Object.assign({}, ...firsts));
    for (const p of parts) out.push(...p.slice(0, 6));
  }
  for (const t of types(s)) {
    if (t === "string") out.push(...strings(s));
    else if (t === "number") out.push(...numbers(s, false));
    else if (t === "integer") out.push(...numbers(s, true));
    else if (t === "boolean") out.push(true, false);
    else if (t === "null") out.push(null);
    else if (t === "array") out.push(...arrays(s, root, depth));
    else if (t === "object") out.push(...objects(s, root, depth));
  }
  if (s.default !== undefined) out.push(s.default);
  out.push(...WRONG_TYPES);
  return dedupe(out, depth === 0 ? 200 : MAX_PER_NODE);
}

/** Candidate tool inputs: the root's candidates that are plain objects. */
export function rootInputs(schema: Record<string, unknown>): Record<string, unknown>[] {
  return gen(schema, schema).filter(isObj);
}
