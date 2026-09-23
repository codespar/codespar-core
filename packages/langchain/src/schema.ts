/**
 * JSON Schema → Zod, faithful for the subset CodeSpar tool `input_schema`s
 * and the MCP servers behind them use.
 *
 * The schema a tool declares is what the API validates against and what the
 * model is told. This is the one place in the adapter where that schema is
 * re-expressed in another language, so it must not change its meaning. The
 * contract, enforced by a differential test against a JSON Schema validator
 * (ajv): the Zod schema never rejects an input the JSON Schema accepts, and
 * accepts more only where a keyword is advisory or marked in
 * {@link KEYWORD_SUPPORT} — in which case the field's description says so.
 *
 * Nothing is parsed while converting: a `$ref` resolves lazily, and parsing
 * a self-referencing definition before it is fully built recurses forever.
 *
 * Imported from `zod/v3`: the classic API this file is written against,
 * which zod 3.25+ and zod 4 both ship, so a project on either works.
 */

import { z } from "zod/v3";
import { KEYWORD_SUPPORT, MARKED_KEYWORDS } from "./keywords.js";

export { KEYWORD_SUPPORT, MARKED_KEYWORDS, renderKeywordTable, type KeywordSupport } from "./keywords.js";

/** A JSON Schema fragment as the API publishes it. */
export type JsonSchema = Record<string, unknown>;

interface Ctx {
  /** The root schema, for local `$ref` resolution. */
  root: JsonSchema;
  /**
   * One Zod instance per referenced target. A `$ref` must resolve to the
   * same instance every time: a consumer that walks the Zod tree to emit
   * JSON Schema (LangChain does, to describe the tool to the model) detects
   * a cycle by identity, and a fresh tree per visit is an unbounded walk.
   */
  refs: Map<JsonSchema, z.ZodTypeAny>;
  /**
   * The schemas being applied to the current value: entered through `$ref`
   * or a combinator, not by descending into a property or an item. A `$ref`
   * back to one of them never reaches new data — every validator loops on
   * it — so it is marked instead of followed.
   */
  sameValue: Set<JsonSchema>;
}

/** The context for a subschema that applies to a nested value (a property, an item). */
function descend(ctx: Ctx): Ctx {
  return { ...ctx, sameValue: new Set() };
}

interface ConvertOptions {
  /** A property listed in `required` keeps its default out of the Zod type. */
  skipDefault?: boolean;
}

type AnyObject = z.ZodObject<z.ZodRawShape>;

function isSchema(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MARKER = "schema construct not translated";

function annotate<T extends z.ZodTypeAny>(field: T, note: string): T {
  const desc = field.description;
  return field.describe(desc ? `${desc} ${note}` : note) as T;
}

function markUntranslated<T extends z.ZodTypeAny>(field: T, what: string): T {
  return annotate(field, `(${MARKER}: ${what})`);
}

/** JSON with object keys sorted: JSON Schema equality ignores key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isSchema(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | boolean | null {
  if (!ref.startsWith("#")) return null;
  const pointer = ref.slice(1);
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return null;
  let node: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isSchema(node)) node = node[key];
    else return null;
  }
  return isSchema(node) || typeof node === "boolean" ? node : null;
}

/**
 * Branches of a typeless node that never accept a plain object (its number,
 * string and array branches, and the branch for the kinds it does not
 * constrain). Recognised when such a union meets an object.
 */
const NON_OBJECT = new WeakSet<z.ZodTypeAny>();

function tagNonObject<T extends z.ZodTypeAny>(t: T): T {
  NON_OBJECT.add(t);
  return t;
}

type Kind = "null" | "boolean" | "number" | "string" | "array" | "object";

function kindOf(v: unknown): Kind {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return typeof v as Kind;
}

function isPlainObject(v: unknown): boolean {
  return kindOf(v) === "object";
}

/** Every value whose kind is not in `constrained`. */
function otherKinds(constrained: Set<Kind>): z.ZodTypeAny {
  return tagNonObject(z.custom<unknown>((v) => v !== undefined && !constrained.has(kindOf(v))));
}

function literal(value: unknown): z.ZodTypeAny {
  if (value === null) return z.null();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value);
  }
  const want = canonical(value);
  return z.custom<unknown>((v) => v !== undefined && canonical(v) === want, { message: `expected ${want}` });
}

function asObject(field: z.ZodTypeAny): AnyObject | null {
  return field instanceof z.ZodObject ? (field as AnyObject) : null;
}

/** Strip refinements to reach what they refine. */
function unwrapEffects(field: z.ZodTypeAny): z.ZodTypeAny {
  let current = field;
  for (let i = 0; i < 32 && current instanceof z.ZodEffects; i++) current = current.innerType();
  return current;
}

function unionOptions(field: z.ZodTypeAny): z.ZodTypeAny[] | null {
  const bare = unwrapEffects(field);
  if (bare instanceof z.ZodUnion || bare instanceof z.ZodDiscriminatedUnion) {
    return bare.options as z.ZodTypeAny[];
  }
  return null;
}

/**
 * The object an object-valued field constrains: the object itself, the
 * object under refinements, or the object branch of a "properties without
 * type" union (whose other branch accepts every non-object value).
 */
function objectUnder(field: z.ZodTypeAny): AnyObject | null {
  const bare = unwrapEffects(field);
  const object = asObject(bare);
  if (object) return object;
  const options = unionOptions(bare);
  if (options && options.some((o) => NON_OBJECT.has(o))) {
    const objects = options.filter((o) => !NON_OBJECT.has(o));
    return objects.length === 1 ? objectUnder(objects[0]!) : null;
  }
  return null;
}

/** Whether a field accepts some non-object values through a typeless node's branches. */
function acceptsNonObjects(field: z.ZodTypeAny): boolean {
  return unionOptions(field)?.some((o) => NON_OBJECT.has(o)) ?? false;
}

/**
 * An object that must also pass `rules`, each checked against the RAW input:
 * after parsing, the object carries defaults other members declared, and a
 * strict member would reject a key the caller never sent.
 */
function withRules(object: AnyObject, rules: z.ZodTypeAny[]): z.ZodTypeAny {
  if (rules.length === 0) return object;
  return z.preprocess((raw, issues) => {
    for (const rule of rules) {
      const parsed = rule.safeParse(raw);
      if (!parsed.success) addIssues(issues, parsed.error);
    }
    return raw;
  }, object);
}

/** A `const`-like value a branch fixes for `key`, if it fixes one. */
function literalValue(field: z.ZodTypeAny): unknown {
  return field instanceof z.ZodLiteral ? (field.value as unknown) : undefined;
}

/**
 * A union. When every branch is a plain object with a key whose literal
 * value is distinct per branch (the action idiom), a discriminated union —
 * which also makes the branches exclusive. Otherwise a plain union.
 */
function union(members: z.ZodTypeAny[]): { type: z.ZodTypeAny; exclusive: boolean } {
  if (members.length === 0) return { type: z.never(), exclusive: true };
  if (members.length === 1) return { type: members[0]!, exclusive: true };
  const objects = members.map(asObject);
  if (objects.every((o): o is AnyObject => o !== null)) {
    const discriminator = Object.keys(objects[0]!.shape).find((key) => {
      const values = objects.map((o) => (o.shape[key] ? literalValue(o.shape[key]!) : undefined));
      return values.every((v) => v !== undefined) && new Set(values.map(canonical)).size === values.length;
    });
    if (discriminator) {
      const options = objects as unknown as [
        z.ZodDiscriminatedUnionOption<string>,
        ...z.ZodDiscriminatedUnionOption<string>[],
      ];
      return { type: z.discriminatedUnion(discriminator, options), exclusive: true };
    }
  }
  return { type: z.union([members[0]!, members[1]!, ...members.slice(2)]), exclusive: false };
}

function compilePattern(pattern: string): RegExp | null {
  for (const flags of ["u", ""]) {
    try {
      return new RegExp(pattern, flags);
    } catch {
      // try the next flag set
    }
  }
  return null;
}

function stringSchema(schema: JsonSchema): z.ZodTypeAny {
  let s = z.string();
  let untranslatedPattern: string | null = null;
  if (typeof schema.pattern === "string") {
    const re = compilePattern(schema.pattern);
    // A pattern JS cannot compile must not take the field, or every tool, down with it.
    if (re) s = s.regex(re);
    else untranslatedPattern = schema.pattern;
  }
  let out: z.ZodTypeAny = s;
  // JSON Schema counts code points; zod's .min()/.max() count UTF-16 units,
  // which puts an emoji at length 2.
  const min = typeof schema.minLength === "number" ? schema.minLength : undefined;
  const max = typeof schema.maxLength === "number" ? schema.maxLength : undefined;
  if (min !== undefined || max !== undefined) {
    out = out.superRefine((v, issues) => {
      const length = Array.from(v as string).length;
      if (min !== undefined && length < min) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: `must have at least ${min} characters` });
      }
      if (max !== undefined && length > max) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: `must have at most ${max} characters` });
      }
    });
  }
  if (untranslatedPattern !== null) out = markUntranslated(out, `pattern ${JSON.stringify(untranslatedPattern)}`);
  return out;
}

function numberSchema(schema: JsonSchema, integer: boolean): z.ZodTypeAny {
  let n = z.number();
  if (integer) n = n.int();
  // draft-4 spelled exclusivity as a boolean next to the bound.
  if (typeof schema.minimum === "number") {
    n = schema.exclusiveMinimum === true ? n.gt(schema.minimum) : n.min(schema.minimum);
  }
  if (typeof schema.maximum === "number") {
    n = schema.exclusiveMaximum === true ? n.lt(schema.maximum) : n.max(schema.maximum);
  }
  if (typeof schema.exclusiveMinimum === "number") n = n.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === "number") n = n.lt(schema.exclusiveMaximum);
  if (typeof schema.multipleOf === "number") n = n.multipleOf(schema.multipleOf);
  return n;
}

/** A subschema position applying to the same value: a schema, or `true` / `false`. */
function sub(value: unknown, ctx: Ctx, opts: ConvertOptions = {}): z.ZodTypeAny {
  if (value === false) return z.never();
  if (isSchema(value)) return convert(value, ctx, opts);
  return z.unknown();
}

function addIssues(issues: z.RefinementCtx, error: z.ZodError, prefix: (string | number)[] = []): void {
  for (const issue of error.issues) issues.addIssue({ ...issue, path: [...prefix, ...issue.path] });
}

/**
 * An array. `prefixItems` (or draft-07 `items: [...]`) constrain positions
 * that are present — a shorter array is valid — and `items` (or
 * `additionalItems`) the positions after them; length and uniqueness apply
 * whichever form the items take.
 */
function arraySchema(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const prefixSource = Array.isArray(schema.prefixItems)
    ? (schema.prefixItems as unknown[])
    : Array.isArray(schema.items)
      ? (schema.items as unknown[])
      : null;
  const restSource = Array.isArray(schema.prefixItems)
    ? schema.items
    : Array.isArray(schema.items)
      ? schema.additionalItems
      : schema.items;
  let base = prefixSource ? z.array(z.unknown()) : z.array(sub(restSource, descend(ctx)));
  if (typeof schema.minItems === "number") base = base.min(schema.minItems);
  if (typeof schema.maxItems === "number") base = base.max(schema.maxItems);
  let out: z.ZodTypeAny = base;
  if (prefixSource) {
    const prefix = prefixSource.map((p) => sub(p, descend(ctx)));
    const rest = sub(restSource, descend(ctx));
    out = out.superRefine((arr, issues) => {
      (arr as unknown[]).forEach((item, i) => {
        const parsed = (i < prefix.length ? prefix[i]! : rest).safeParse(item);
        if (!parsed.success) addIssues(issues, parsed.error, [i]);
      });
    });
  }
  if (schema.uniqueItems === true) {
    out = out.refine((arr) => new Set((arr as unknown[]).map(canonical)).size === (arr as unknown[]).length, {
      message: "items must be unique",
    });
  }
  return out;
}

/**
 * Whether a field's type admits `undefined`, decided from the tree and never
 * by parsing. Over-reporting costs one comparison; parsing here would
 * recurse into a `$ref` still being built.
 */
function admitsUndefined(field: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): boolean {
  if (seen.has(field)) return true;
  seen.add(field);
  if (field instanceof z.ZodDefault) return false;
  if (
    field instanceof z.ZodOptional ||
    field instanceof z.ZodUnknown ||
    field instanceof z.ZodAny ||
    field instanceof z.ZodUndefined ||
    field instanceof z.ZodLazy
  ) {
    return true;
  }
  if (field instanceof z.ZodNullable) return admitsUndefined(field.unwrap(), seen);
  if (field instanceof z.ZodEffects) return admitsUndefined(field.innerType(), seen);
  const options = field instanceof z.ZodUnion ? (field.options as z.ZodTypeAny[]) : null;
  if (options) return options.some((o) => admitsUndefined(o, seen));
  if (field instanceof z.ZodIntersection) {
    return admitsUndefined(field._def.left, seen) && admitsUndefined(field._def.right, seen);
  }
  return false;
}

/**
 * `required` may name keys `properties` does not declare (the "one of these
 * must be present" idiom inside anyOf). Presence is the constraint.
 */
function requireUndeclared(object: AnyObject, undeclared: string[]): z.ZodTypeAny {
  if (undeclared.length === 0) return object;
  return object.superRefine((value, issues) => {
    for (const key of undeclared) {
      if (!(key in value)) issues.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Required" });
    }
  });
}

/**
 * An object: every declared property, required or optional, then the
 * additional-properties policy. JSON Schema's default is to allow unknown
 * keys, so the default here is `.passthrough()`: what the model sends
 * reaches the API instead of being stripped. `additionalProperties: false`
 * is `.strict()`; a schema there is `.catchall()`.
 */
function objectSchema(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(
    (Array.isArray(schema.required) ? (schema.required as unknown[]) : []).filter(
      (k): k is string => typeof k === "string",
    ),
  );
  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    const isRequired = required.has(key);
    // A required property is required: its default is documentation, not
    // a value the caller may omit.
    let field = sub(prop, descend(ctx), { skipDefault: isRequired });
    if (isRequired && admitsUndefined(field)) {
      const desc = field.description;
      field = field.refine((v) => v !== undefined, { message: "Required" });
      if (desc) field = field.describe(desc);
    }
    shape[key] = isRequired || DEFAULTS.has(field) ? field : field.optional();
  }
  const base = z.object(shape);
  const extra = schema.additionalProperties;
  const object =
    extra === false
      ? base.strict()
      : isSchema(extra)
        ? base.catchall(convert(extra, descend(ctx)))
        : base.passthrough();
  return requireUndeclared(object, [...required].filter((k) => !(k in properties)));
}

function byType(type: string, schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  switch (type) {
    case "string":
      return stringSchema(schema);
    case "number":
      return numberSchema(schema, false);
    case "integer":
      return numberSchema(schema, true);
    case "boolean":
      return z.boolean();
    case "null":
      return z.null();
    case "array":
      return arraySchema(schema, ctx);
    case "object":
      return objectSchema(schema, ctx);
    default:
      return markUntranslated(z.unknown(), `type ${JSON.stringify(type)}`);
  }
}

/** A defaulted field's parts, so `allOf` can intersect two of them on their types. */
const DEFAULTS = new WeakMap<z.ZodTypeAny, { inner: z.ZodTypeAny; value: unknown }>();

/**
 * `default` is an annotation in JSON Schema. The field becomes optional and
 * the description carries the value; an omitted key is filled with it only
 * when the field accepts it. That check runs on the first parse that needs
 * it, and is remembered: during conversion a `$ref` may still be under
 * construction, and parsing through it then recurses forever.
 */
function applyDefault(field: z.ZodTypeAny, value: unknown): z.ZodTypeAny {
  const inner = annotate(field, `(default: ${JSON.stringify(value)})`);
  let accepted: boolean | undefined;
  let checking = false;
  const copy = () => JSON.parse(JSON.stringify(value)) as unknown;
  // The default goes into the output as written, not parsed again: a default
  // that contains the same schema (an item that is `$ref: "#"`) would
  // otherwise be filled with itself forever. While the acceptance check
  // runs, nested omissions stay omitted for the same reason.
  const defaulted = inner.optional().transform((parsed) => {
    if (parsed !== undefined) return parsed;
    if (accepted === undefined) {
      if (checking) return undefined;
      checking = true;
      try {
        accepted = inner.safeParse(copy()).success;
      } finally {
        checking = false;
      }
    }
    return accepted ? copy() : undefined;
  });
  const described = inner.description ? defaulted.describe(inner.description) : defaulted;
  DEFAULTS.set(described, { inner, value });
  return described;
}

/** Convert any JSON Schema fragment to the Zod type that accepts the same values. */
export function convert(schema: JsonSchema, ctx: Ctx, opts: ConvertOptions = {}): z.ZodTypeAny {
  const entered = !ctx.sameValue.has(schema);
  ctx.sameValue.add(schema);
  let field: z.ZodTypeAny;
  try {
    field = core(schema, ctx);
  } finally {
    if (entered) ctx.sameValue.delete(schema);
  }
  if (typeof schema.description === "string") {
    const existing = field.description;
    // A note set deeper in core() rides behind the schema's own words; a
    // description a `$ref` target already carries is left as it is.
    if (existing === undefined) field = field.describe(schema.description);
    else if (existing.startsWith("(")) field = field.describe(`${schema.description} ${existing}`);
  }
  // `format` is advisory: zod's format checks are stricter than a JSON Schema
  // validator's in places (case, quoted local parts, URNs), so enforcing them
  // would reject valid input. It rides in the description, typed or not.
  if (typeof schema.format === "string") field = annotate(field, `(format: ${schema.format})`);
  const unsupported = MARKED_KEYWORDS.filter((k) => schema[k] !== undefined);
  if (unsupported.length > 0) field = markUntranslated(field, unsupported.join(", "));
  if (schema.nullable === true) field = field.nullable();
  if (schema.default !== undefined && !opts.skipDefault) field = applyDefault(field, schema.default);
  return field;
}

/** The `$ref` target's Zod type: one instance per target, registered before conversion. */
function reference(ref: string, ctx: Ctx): z.ZodTypeAny {
  const target = resolveRef(ref, ctx.root);
  if (target === null) return markUntranslated(z.unknown(), `$ref ${ref}`);
  if (typeof target === "boolean") return target ? z.unknown() : z.never();
  if (ctx.sameValue.has(target)) return markUntranslated(z.unknown(), `$ref ${ref} cycles on the same value`);
  const known = ctx.refs.get(target);
  if (known) return known;
  let converted: z.ZodTypeAny | null = null;
  const at: Ctx = { ...ctx, sameValue: new Set(ctx.sameValue) };
  const lazy = z.lazy(() => (converted ??= convert(target, at)));
  ctx.refs.set(target, lazy);
  return lazy;
}

/** A field with its optionality and default lifted off, so two can be intersected on their types. */
function lift(field: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; default?: unknown } {
  const defaulted = DEFAULTS.get(field);
  if (defaulted) return { inner: defaulted.inner, optional: true, default: defaulted.value };
  if (field instanceof z.ZodOptional) return { inner: field.unwrap(), optional: true };
  return { inner: field, optional: false };
}

/**
 * One key declared by two `allOf` members: both types hold. The key is
 * optional only when neither side requires it; a default survives when the
 * sides agree on one (or only one has it) — intersecting two defaults
 * directly fails every input that omits the key.
 */
function intersectFields(fa: z.ZodTypeAny, fb: z.ZodTypeAny): z.ZodTypeAny {
  const la = lift(fa);
  const lb = lift(fb);
  const descriptions = [...new Set([fa.description, fb.description].filter((d): d is string => !!d))];
  let inner: z.ZodTypeAny = z.intersection(la.inner, lb.inner);
  if (descriptions.length > 0) inner = inner.describe(descriptions.join(" "));
  if (!la.optional || !lb.optional) return inner;
  const defaults = [la, lb].filter((l) => "default" in l).map((l) => l.default);
  if (defaults.length === 0) return inner.optional();
  if (defaults.length === 1 || canonical(defaults[0]) === canonical(defaults[1])) {
    return applyDefault(inner, defaults[0]);
  }
  return annotate(inner.optional(), `(defaults differ: ${defaults.map((d) => JSON.stringify(d)).join(", ")})`);
}

/** One pass-through object carrying every key either side declares, shared keys intersected. */
function mergeShapes(a: AnyObject, b: AnyObject): AnyObject {
  const shape: z.ZodRawShape = {};
  for (const key of new Set([...Object.keys(a.shape), ...Object.keys(b.shape)])) {
    const fa = a.shape[key];
    const fb = b.shape[key];
    shape[key] = fa && fb ? intersectFields(fa, fb) : (fa ?? fb)!;
  }
  return z.object(shape).passthrough();
}

/** Whether a field is exactly a pass-through object, with nothing its merged shape would lose. */
function isPlainOpenObject(field: z.ZodTypeAny): boolean {
  const object = asObject(field);
  return object !== null && object._def.unknownKeys === "passthrough" && object._def.catchall instanceof z.ZodNever;
}

/**
 * Two schemas that must both hold. When both constrain objects, the result
 * is one object: its shape (what the model sees) carries every key either
 * side declares, shared keys intersected, and every side that is more than
 * an open object is re-checked whole as a rule — so each side's
 * `additionalProperties` judges only its own declared keys, as JSON Schema
 * does, and its refinements hold. Otherwise an intersection.
 */
function both(a: z.ZodTypeAny, b: z.ZodTypeAny): z.ZodTypeAny {
  const ao = objectUnder(a);
  const bo = objectUnder(b);
  if (!ao || !bo) return z.intersection(a, b);
  const merged = withRules(
    mergeShapes(ao, bo),
    [a, b].filter((side) => !isPlainOpenObject(side)),
  );
  // Two typeless nodes both accept some non-objects; so does their conjunction.
  if (!acceptsNonObjects(a) || !acceptsNonObjects(b)) return merged;
  const nonObjects = tagNonObject(
    z.unknown().superRefine((value, issues) => {
      if (value === undefined || isPlainObject(value)) {
        issues.addIssue({ code: z.ZodIssueCode.custom, message: "expected a non-object value" });
        return;
      }
      for (const side of [a, b]) {
        const parsed = side.safeParse(value);
        if (!parsed.success) addIssues(issues, parsed.error);
      }
    }),
  );
  return z.union([merged, nonObjects]);
}

/** `oneOf`: a union whose value must match exactly one branch. */
function exactlyOne(branches: z.ZodTypeAny[]): z.ZodTypeAny {
  const { type, exclusive } = union(branches);
  if (exclusive) return type;
  return z.preprocess((raw, issues) => {
    const matches = branches.filter((b) => b.safeParse(raw).success).length;
    if (matches > 1) {
      issues.addIssue({ code: z.ZodIssueCode.custom, message: `matches ${matches} oneOf branches, expected exactly one` });
    }
    return raw;
  }, type);
}

/** `anyOf` / `oneOf` / `allOf` as one Zod type (all of them apply), or null when the schema has none. */
function combinator(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny | null {
  const parts: z.ZodTypeAny[] = [];
  if (Array.isArray(schema.allOf)) {
    const members = (schema.allOf as unknown[]).map((s) => sub(s, ctx));
    parts.push(members.length === 0 ? z.unknown() : members.slice(1).reduce(both, members[0]!));
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as unknown[]).map((s) => sub(s, ctx));
    parts.push(union(branches).type);
  }
  if (Array.isArray(schema.oneOf)) {
    parts.push(exactlyOne((schema.oneOf as unknown[]).map((s) => sub(s, ctx))));
  }
  if (parts.length === 0) return null;
  return parts.slice(1).reduce(both, parts[0]!);
}

/** The schema's own `type` / `properties` / `items` constraint, or null when it declares none. */
function structural(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny | null {
  const type = schema.type;
  if (Array.isArray(type)) {
    const types = (type as unknown[]).filter((t): t is string => typeof t === "string");
    return union(types.map((t) => byType(t, schema, ctx))).type;
  }
  if (typeof type === "string") return byType(type, schema, ctx);
  // Without `type`, each keyword constrains the values of its own kind and
  // every other kind passes.
  const has = (keys: string[]) => keys.some((k) => schema[k] !== undefined);
  const branches: z.ZodTypeAny[] = [];
  const constrained = new Set<Kind>();
  if (isSchema(schema.properties) || schema.additionalProperties !== undefined || Array.isArray(schema.required)) {
    branches.push(objectSchema(schema, ctx));
    constrained.add("object");
  }
  if (has(["items", "prefixItems", "additionalItems", "minItems", "maxItems", "uniqueItems"])) {
    branches.push(tagNonObject(arraySchema(schema, ctx)));
    constrained.add("array");
  }
  if (has(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"])) {
    branches.push(tagNonObject(numberSchema(schema, false)));
    constrained.add("number");
  }
  if (has(["minLength", "maxLength", "pattern"])) {
    branches.push(tagNonObject(stringSchema(schema)));
    constrained.add("string");
  }
  if (branches.length === 0) return null;
  const all = [...branches, otherKinds(constrained)];
  return z.union([all[0]!, all[1]!, ...all.slice(2)]);
}

/** Keywords that constrain a value (anything outside the advisory set). */
function hasConstraints(schema: JsonSchema): boolean {
  return Object.keys(schema).some((k) => KEYWORD_SUPPORT[k] === "translated" && k !== "$defs" && k !== "definitions");
}

function core(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  if (typeof schema.$ref === "string") {
    const target = reference(schema.$ref, ctx);
    // Siblings of `$ref` apply too (2019-09 and later, and ajv in every draft).
    const { $ref: _ref, default: _d, description: _desc, nullable: _n, ...rest } = schema;
    return hasConstraints(rest) ? both(target, core(rest, ctx)) : target;
  }
  if (schema.const !== undefined) return literal(schema.const);

  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length > 0 && values.every((v) => typeof v === "string")) {
      const strings = values as string[];
      return strings.length === 1
        ? z.literal(strings[0]!)
        : z.enum([strings[0]!, ...strings.slice(1)] as [string, ...string[]]);
    }
    return union(values.map(literal)).type;
  }

  // A combinator beside the schema's own type/properties constrains it
  // further; both apply.
  const combined = combinator(schema, ctx);
  const own = structural(schema, ctx);
  if (combined && own) return both(own, combined);
  return combined ?? own ?? z.unknown();
}

/**
 * A tool's input schema: the object itself, or the object under a
 * refinement when the root schema carries a rule an object cannot express
 * alone (`anyOf: [{ required: [...] }, ...]`, a union of object branches, a
 * `required` key `properties` does not declare, an `allOf` member's own
 * `additionalProperties`). LangChain accepts both; {@link toolInputShape}
 * reaches the properties in either.
 */
export type ToolInputSchema = AnyObject | z.ZodEffects<AnyObject, unknown, unknown>;

/** The object under a tool input schema, whichever form it takes. */
export function toolInputObject(schema: ToolInputSchema): AnyObject {
  return schema instanceof z.ZodEffects ? schema.innerType() : schema;
}

/** The properties of a tool input schema, whichever form it takes. */
export function toolInputShape(schema: ToolInputSchema): z.ZodRawShape {
  return toolInputObject(schema).shape;
}

/** Strip the value-neutral wrappers a converted root may carry (lazy, default, nullable, optional). */
function unwrapNeutral(field: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): z.ZodTypeAny {
  let current = field;
  for (let i = 0; i < 16; i++) {
    if (seen.has(current)) return current;
    seen.add(current);
    const defaulted = DEFAULTS.get(current);
    if (defaulted) current = defaulted.inner;
    else if (current instanceof z.ZodLazy) current = current.schema;
    else if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodNullable || current instanceof z.ZodOptional) current = current.unwrap();
    else return current;
  }
  return current;
}

function flattenIntersection(field: z.ZodTypeAny, seen = new Set<z.ZodTypeAny>()): z.ZodTypeAny[] {
  if (seen.has(field)) return [];
  seen.add(field);
  // Its own guard: the lazy just recorded here must still be resolved.
  const bare = unwrapNeutral(field);
  if (bare instanceof z.ZodIntersection) {
    return [...flattenIntersection(bare._def.left, seen), ...flattenIntersection(bare._def.right, seen)];
  }
  return [bare];
}

/**
 * The object a union of branches shows the model: every key any object
 * branch declares, optional, typed as the union of what the branches say.
 * The union itself stays a rule over it.
 */
function unionSurface(options: z.ZodTypeAny[]): { surface: AnyObject | null; nonObjectBranch: boolean } {
  const objects: AnyObject[] = [];
  let nonObjectBranch = false;
  for (const option of options) {
    if (NON_OBJECT.has(option)) continue;
    const object = objectUnder(unwrapNeutral(option));
    if (object) objects.push(object);
    // A branch that only accepts non-objects is irrelevant to an object
    // input; it is worth a mark only when it is itself untranslated.
    else if (option.description?.includes(MARKER)) nonObjectBranch = true;
  }
  if (objects.length === 0) return { surface: null, nonObjectBranch };
  const fields = new Map<string, z.ZodTypeAny[]>();
  for (const o of objects) {
    for (const [key, field] of Object.entries(o.shape)) {
      const list = fields.get(key) ?? [];
      if (!list.includes(field)) list.push(field);
      fields.set(key, list);
    }
  }
  const shape: z.ZodRawShape = {};
  for (const [key, list] of fields) {
    const field = list.length === 1 ? list[0]! : z.union([list[0]!, list[1]!, ...list.slice(2)]);
    shape[key] = field.isOptional() ? field : field.optional();
  }
  return { surface: z.object(shape).passthrough(), nonObjectBranch };
}

/**
 * Convert a tool's `input_schema` to the object schema LangChain needs.
 *
 * A root `$ref` is resolved and value-neutral wrappers are stripped. The
 * root's parts (an intersection is flattened, whatever its nesting) each
 * contribute: an object its keys; a refined object or a union of object
 * branches its keys plus itself as a rule. What is left is the object the
 * model sees and the rules the input must also pass. A root with no object
 * anywhere yields an empty pass-through object, and a part that cannot
 * contribute an object is named in the description — never silently empty.
 */
export function jsonSchemaToZod(schema: JsonSchema): ToolInputSchema {
  const ctx: Ctx = { root: schema, refs: new Map(), sameValue: new Set() };
  // The root is converted as it is: a root `$ref` resolves lazily and its
  // siblings apply, as they do at any depth.
  const converted = convert(schema, ctx);

  let object: AnyObject | null = null;
  const rules: z.ZodTypeAny[] = [];
  const notes = new Set<string>();
  const absorb = (candidate: AnyObject) => {
    object = object ? mergeShapes(object, candidate) : candidate;
  };
  const parts = flattenIntersection(converted);
  const hasObject = parts.some((p) => objectUnder(p) !== null);
  for (const part of parts) {
    const under = objectUnder(part);
    if (under) {
      absorb(under);
      if (!isPlainOpenObject(part)) rules.push(part);
      continue;
    }
    const options = unionOptions(part);
    if (options) {
      const { surface, nonObjectBranch } = unionSurface(options);
      if (surface) {
        absorb(surface);
        rules.push(part);
        if (nonObjectBranch) notes.add("root union has an untranslated non-object branch");
        continue;
      }
    }
    notes.add(hasObject ? "root intersects a non-object schema" : "root schema is not an object");
  }

  let result: AnyObject = object ?? z.object({}).passthrough();
  if (converted.description) result = result.describe(converted.description);
  for (const note of notes) result = markUntranslated(result, note);
  return withRules(result, rules) as ToolInputSchema;
}

/** Convert any JSON Schema fragment; `root` (default: the fragment) resolves local `$ref`s. */
export function jsonSchemaToZodType(schema: JsonSchema, root: JsonSchema = schema): z.ZodTypeAny {
  return convert(schema, { root, refs: new Map(), sameValue: new Set() });
}
