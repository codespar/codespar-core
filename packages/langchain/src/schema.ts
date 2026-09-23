/**
 * JSON Schema → Zod, faithful for the subset CodeSpar tool `input_schema`s
 * and the MCP servers behind them use.
 *
 * The schema a tool declares is what the API validates against and what the
 * model is told. This is the one place in the adapter where that schema is
 * re-expressed in another language, so it must not change its meaning: an
 * `enum` is a closed vocabulary, a nested object keeps its own `required`,
 * a `oneOf: [number, string]` amount is a union and not a string. A
 * construct this converter does not understand is never silently narrowed
 * to `z.string()`, and never takes the rest of its node with it: the known
 * part is translated and the description is marked, so the value reaches
 * the API as sent and the gap is visible in the schema.
 *
 * Imported from `zod/v3`: the classic API this file is written against,
 * which zod 3.25+ and zod 4 both ship, so a project on either works.
 */

import { z } from "zod/v3";

/** A JSON Schema fragment as the API publishes it. */
export type JsonSchema = Record<string, unknown>;

/** Keywords whose validation semantics this converter does not express. */
const UNTRANSLATED = [
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

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
}

/** Per-property conversion switches. */
interface ConvertOptions {
  /** A property listed in `required` keeps its default out of the Zod type. */
  skipDefault?: boolean;
}

type AnyObject = z.ZodObject<z.ZodRawShape>;

function isSchema(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const MARKER = "schema construct not translated";

/** Append a note to a field's description (or start one). */
function annotate<T extends z.ZodTypeAny>(field: T, note: string): T {
  const desc = field.description;
  return field.describe(desc ? `${desc} ${note}` : note) as T;
}

/** Mark the field as carrying a construct this converter did not translate. */
function markUntranslated<T extends z.ZodTypeAny>(field: T, what: string): T {
  return annotate(field, `(${MARKER}: ${what})`);
}

/** Resolve a local JSON pointer (`#/definitions/x`, `#/$defs/x`, `#/properties/…`). */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
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
  return isSchema(node) ? node : null;
}

function literal(value: unknown): z.ZodTypeAny {
  if (value === null) return z.null();
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return z.literal(value);
  }
  const want = JSON.stringify(value);
  return z.unknown().refine((v) => JSON.stringify(v) === want, { message: `expected ${want}` });
}

function asObject(field: z.ZodTypeAny): AnyObject | null {
  return field instanceof z.ZodObject ? (field as AnyObject) : null;
}

/** The object under a chain of refinements, if that is what the field is. */
function objectUnder(field: z.ZodTypeAny): AnyObject | null {
  let current = field;
  for (let i = 0; i < 16; i++) {
    const object = asObject(current);
    if (object) return object;
    if (current instanceof z.ZodEffects) current = current.innerType();
    else return null;
  }
  return null;
}

/**
 * Branches that must be objects: a discriminated union when every branch
 * is a plain object with one common literal key (the action idiom), else
 * a plain union.
 */
function union(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 0) return z.never();
  if (members.length === 1) return members[0]!;
  const objects = members.map(asObject);
  if (objects.every((o): o is AnyObject => o !== null)) {
    const first = objects[0]!;
    const discriminator = Object.keys(first.shape).find((key) =>
      objects.every((o) => o.shape[key] instanceof z.ZodLiteral),
    );
    if (discriminator) {
      return z.discriminatedUnion(discriminator, [
        objects[0]!,
        objects[1]!,
        ...objects.slice(2),
      ] as unknown as [z.ZodDiscriminatedUnionOption<string>, ...z.ZodDiscriminatedUnionOption<string>[]]);
    }
  }
  return z.union([members[0]!, members[1]!, ...members.slice(2)]);
}

/** A JSON Schema `pattern` as a JS RegExp, or null when JS cannot express it. */
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
  if (typeof schema.minLength === "number") s = s.min(schema.minLength);
  if (typeof schema.maxLength === "number") s = s.max(schema.maxLength);
  let untranslatedPattern: string | null = null;
  if (typeof schema.pattern === "string") {
    const re = compilePattern(schema.pattern);
    // A pattern JS cannot compile must not take the field, or every tool, down with it.
    if (re) s = s.regex(re);
    else untranslatedPattern = schema.pattern;
  }
  switch (schema.format) {
    case "email":
      s = s.email();
      break;
    case "uri":
    case "url":
      s = s.url();
      break;
    case "uuid":
      s = s.uuid();
      break;
    case "date-time":
      s = s.datetime({ offset: true });
      break;
    case "date":
      s = s.date();
      break;
    default:
      // Other formats are advisory in JSON Schema; the description carries them.
      break;
  }
  return untranslatedPattern === null
    ? s
    : markUntranslated(s, `pattern ${JSON.stringify(untranslatedPattern)}`);
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

/**
 * A tuple: 2020-12 `prefixItems` with `items` as the rest (a schema, `false`
 * for none, absent for anything), or draft-07 `items: [...]` with
 * `additionalItems` playing the same role.
 */
function tupleSchema(prefix: unknown[], rest: unknown, ctx: Ctx): z.ZodTypeAny {
  const members = prefix.map((it) => (isSchema(it) ? convert(it, ctx) : z.unknown()));
  const tuple = members.length === 0 ? z.tuple([]) : z.tuple([members[0]!, ...members.slice(1)]);
  if (rest === false) return tuple;
  return tuple.rest(isSchema(rest) ? convert(rest, ctx) : z.unknown());
}

function arraySchema(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const items = schema.items;
  if (Array.isArray(schema.prefixItems)) return tupleSchema(schema.prefixItems, items, ctx);
  if (Array.isArray(items)) return tupleSchema(items, schema.additionalItems, ctx);
  let a =
    items === false
      ? z.array(z.never()).max(0)
      : z.array(isSchema(items) ? convert(items, ctx) : z.unknown());
  if (typeof schema.minItems === "number") a = a.min(schema.minItems);
  if (typeof schema.maxItems === "number") a = a.max(schema.maxItems);
  if (schema.uniqueItems === true) {
    return a.refine((arr) => new Set(arr.map((v) => JSON.stringify(v))).size === arr.length, {
      message: "items must be unique",
    });
  }
  return a;
}

/**
 * `required` may name keys `properties` does not declare (the "one of these
 * must be present" idiom inside anyOf). Presence is the constraint.
 */
function requireUndeclared(object: AnyObject, undeclared: string[]): z.ZodTypeAny {
  if (undeclared.length === 0) return object;
  return object.superRefine((value, issues) => {
    for (const key of undeclared) {
      if (!(key in value)) {
        issues.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Required" });
      }
    }
  });
}

/**
 * Whether a field would let a required key be omitted. A lazy field is
 * not probed — probing a self-referencing definition mid-conversion would
 * recurse — and is wrapped regardless, which costs one comparison.
 */
function acceptsUndefined(field: z.ZodTypeAny): boolean {
  if (field instanceof z.ZodLazy) return true;
  return field.safeParse(undefined).success;
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
    let field = isSchema(prop) ? convert(prop, ctx, { skipDefault: isRequired }) : z.unknown();
    if (isRequired && acceptsUndefined(field)) {
      // `unknown`, a nullable unknown, a lazy empty target: each would read
      // as optional. Presence is still required.
      const desc = field.description;
      field = field.refine((v) => v !== undefined, { message: "Required" });
      if (desc) field = field.describe(desc);
    }
    shape[key] = isRequired || field instanceof z.ZodDefault ? field : field.optional();
  }
  const base = z.object(shape);
  const extra = schema.additionalProperties;
  const object =
    extra === false ? base.strict() : isSchema(extra) ? base.catchall(convert(extra, ctx)) : base.passthrough();
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

/**
 * `default` is an annotation in JSON Schema. It becomes a Zod default only
 * when the field accepts it; otherwise the field stays optional and the
 * description carries the value, so a `null` default on a string does not
 * make every omission a validation error.
 */
function applyDefault(field: z.ZodTypeAny, value: unknown): z.ZodTypeAny {
  if (field.safeParse(value).success) return field.default(value as never);
  return annotate(field, `(default: ${JSON.stringify(value)})`);
}

/** Convert any JSON Schema fragment to the Zod type that accepts the same values. */
export function convert(schema: JsonSchema, ctx: Ctx, opts: ConvertOptions = {}): z.ZodTypeAny {
  let field = core(schema, ctx);
  if (typeof schema.description === "string") {
    const existing = field.description;
    // A marker set deeper in core() rides behind the schema's own words; a
    // description a `$ref` target already carries is left as it is.
    if (existing === undefined) field = field.describe(schema.description);
    else if (existing.startsWith(`(${MARKER}`)) field = field.describe(`${schema.description} ${existing}`);
  }
  const unsupported = UNTRANSLATED.filter((k) => schema[k] !== undefined);
  if (unsupported.length > 0) field = markUntranslated(field, unsupported.join(", "));
  if (schema.nullable === true) field = field.nullable();
  if (schema.default !== undefined && !opts.skipDefault) field = applyDefault(field, schema.default);
  return field;
}

/** The `$ref` target's Zod type: one instance per target, registered before conversion. */
function reference(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const ref = schema.$ref as string;
  const target = resolveRef(ref, ctx.root);
  if (!target) return markUntranslated(z.unknown(), `$ref ${ref}`);
  const known = ctx.refs.get(target);
  if (known) return known;
  let converted: z.ZodTypeAny | null = null;
  const lazy = z.lazy(() => (converted ??= convert(target, ctx)));
  ctx.refs.set(target, lazy);
  return lazy;
}

type UnknownKeys = "strict" | "catchall" | "strip" | "passthrough";

function unknownKeysOf(object: AnyObject): { kind: UnknownKeys; catchall: z.ZodTypeAny | null } {
  const catchall = object._def.catchall as z.ZodTypeAny;
  if (!(catchall instanceof z.ZodNever)) return { kind: "catchall", catchall };
  return { kind: object._def.unknownKeys as UnknownKeys, catchall: null };
}

/**
 * Two object schemas that must both hold, as one object: a key only one
 * side declares is taken as is; a key both declare is the intersection of
 * the two fields, so a `pattern` added by an `allOf` member still applies
 * and a required side keeps the key required. Unknown keys follow the
 * stricter side (`strict` > `catchall` > `strip` > `passthrough`). A plain
 * `.merge()` would be last-wins on both counts.
 */
function mergeObjects(a: AnyObject, b: AnyObject): AnyObject {
  const shape: z.ZodRawShape = {};
  for (const key of new Set([...Object.keys(a.shape), ...Object.keys(b.shape)])) {
    const fa = a.shape[key];
    const fb = b.shape[key];
    shape[key] = fa && fb ? intersectFields(fa, fb) : (fa ?? fb)!;
  }
  const base = z.object(shape);
  const ka = unknownKeysOf(a);
  const kb = unknownKeysOf(b);
  if (ka.kind === "strict" || kb.kind === "strict") return base.strict();
  if (ka.catchall && kb.catchall) return base.catchall(z.intersection(ka.catchall, kb.catchall));
  if (ka.catchall || kb.catchall) return base.catchall((ka.catchall ?? kb.catchall)!);
  if (ka.kind === "strip" || kb.kind === "strip") return base;
  return base.passthrough();
}

/** A field with its optionality and default lifted off, so two can be intersected on their types. */
function lift(field: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; default?: unknown } {
  if (field instanceof z.ZodDefault) {
    return { inner: field._def.innerType as z.ZodTypeAny, optional: true, default: field._def.defaultValue() };
  }
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
  const inner = z.intersection(la.inner, lb.inner);
  if (!la.optional || !lb.optional) return inner;
  const defaults = [la, lb].filter((l) => "default" in l).map((l) => l.default);
  if (defaults.length === 0) return inner.optional();
  if (defaults.length === 1 || JSON.stringify(defaults[0]) === JSON.stringify(defaults[1])) {
    return inner.default(defaults[0] as never);
  }
  return annotate(inner.optional(), `(defaults differ: ${defaults.map((d) => JSON.stringify(d)).join(", ")})`);
}

/** Two schemas that must both hold: merged when both are objects, else an intersection. */
function both(a: z.ZodTypeAny, b: z.ZodTypeAny): z.ZodTypeAny {
  const ao = asObject(a);
  const bo = asObject(b);
  if (ao && bo) return mergeObjects(ao, bo);
  return z.intersection(a, b);
}

/** `anyOf` / `oneOf` / `allOf` as one Zod type, or null when the schema has none. */
function combinator(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny | null {
  let all: z.ZodTypeAny | null = null;
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as unknown[]).filter(isSchema).map((s) => convert(s, ctx));
    all = parts.length === 0 ? z.unknown() : parts.slice(1).reduce<z.ZodTypeAny>(both, parts[0]!);
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? (schema.anyOf as unknown[])
    : Array.isArray(schema.oneOf)
      ? (schema.oneOf as unknown[])
      : null;
  let any: z.ZodTypeAny | null = null;
  if (alternatives) {
    const branches = alternatives.filter(isSchema);
    const nullBranch = branches.some((b) => b.type === "null");
    const rest = branches.filter((b) => b.type !== "null").map((b) => convert(b, ctx));
    const u = rest.length === 0 ? z.null() : union(rest);
    any = nullBranch && rest.length > 0 ? u.nullable() : u;
  }
  // `allOf` and `anyOf` on one node both apply.
  if (all && any) return both(all, any);
  return all ?? any;
}

/** The schema's own `type` / `properties` / `items` constraint, or null when it declares none. */
function structural(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny | null {
  const type = schema.type;
  if (Array.isArray(type)) {
    const types = (type as unknown[]).filter((t): t is string => typeof t === "string");
    const nullable = types.includes("null");
    const rest = types.filter((t) => t !== "null").map((t) => byType(t, schema, ctx));
    if (rest.length === 0) return z.null();
    const u = union(rest);
    return nullable ? u.nullable() : u;
  }
  if (typeof type === "string") return byType(type, schema, ctx);
  if (
    isSchema(schema.properties) ||
    schema.additionalProperties !== undefined ||
    Array.isArray(schema.required)
  ) {
    return objectSchema(schema, ctx);
  }
  if (schema.items !== undefined || schema.prefixItems !== undefined) return arraySchema(schema, ctx);
  return null;
}

function core(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  if (typeof schema.$ref === "string") return reference(schema, ctx);
  if (schema.const !== undefined) return literal(schema.const);

  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    if (values.length > 0 && values.every((v) => typeof v === "string")) {
      const strings = values as string[];
      return strings.length === 1
        ? z.literal(strings[0]!)
        : z.enum([strings[0]!, ...strings.slice(1)] as [string, ...string[]]);
    }
    return union(values.map(literal));
  }

  // A combinator beside the schema's own type/properties constrains it
  // further; both apply. Dropping the siblings turned "an object with these
  // properties, one of which is required" into a bare union.
  const combined = combinator(schema, ctx);
  const own = structural(schema, ctx);
  if (combined && own) return both(own, combined);
  return combined ?? own ?? z.unknown();
}

/**
 * A tool's input schema: the object itself, or the object under a
 * refinement when the root schema carries a rule an object cannot express
 * alone (`anyOf: [{ required: [...] }, ...]`, a union of object branches, a
 * `required` key `properties` does not declare). LangChain accepts both;
 * {@link toolInputShape} reaches the properties in either.
 */
export type ToolInputSchema = AnyObject | z.ZodEffects<AnyObject>;

/** The object under a tool input schema, whichever form it takes. */
export function toolInputObject(schema: ToolInputSchema): AnyObject {
  return schema instanceof z.ZodEffects ? schema.innerType() : schema;
}

/** The properties of a tool input schema, whichever form it takes. */
export function toolInputShape(schema: ToolInputSchema): z.ZodRawShape {
  return toolInputObject(schema).shape;
}

/** Strip the value-neutral wrappers a converted node may carry (lazy, default, nullable, optional). */
function unwrapNeutral(field: z.ZodTypeAny): z.ZodTypeAny {
  let current = field;
  for (let i = 0; i < 16; i++) {
    if (current instanceof z.ZodLazy) current = current.schema;
    else if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodNullable || current instanceof z.ZodOptional) current = current.unwrap();
    else return current;
  }
  return current;
}

/** Every operand of a (nested) intersection, wrappers stripped, in order. */
function flattenIntersection(field: z.ZodTypeAny): z.ZodTypeAny[] {
  const bare = unwrapNeutral(field);
  if (bare instanceof z.ZodIntersection) {
    return [
      ...flattenIntersection(bare._def.left as z.ZodTypeAny),
      ...flattenIntersection(bare._def.right as z.ZodTypeAny),
    ];
  }
  return [bare];
}

function unionOptions(field: z.ZodTypeAny): z.ZodTypeAny[] | null {
  if (field instanceof z.ZodUnion) return field.options as z.ZodTypeAny[];
  if (field instanceof z.ZodDiscriminatedUnion) return field.options as z.ZodTypeAny[];
  return null;
}

/**
 * The surface a union of object branches shows the model: every key any
 * branch declares, optional, typed as the union of what the branches say.
 * The union itself is enforced as a refinement over it, so the model sees
 * the parameters and the API's rule still applies.
 */
function unionSurface(options: z.ZodTypeAny[]): AnyObject | null {
  const objects = options.map(objectUnder);
  if (!objects.every((o): o is AnyObject => o !== null)) return null;
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
  return z.object(shape).passthrough();
}

/**
 * Convert a tool's `input_schema` (an object schema) to a Zod object schema.
 * A root `$ref` is resolved eagerly and value-neutral wrappers are
 * stripped. An intersection is flattened and its object operands merged
 * into one object; a refinement over an object, and a union of object
 * branches, are kept as rules over that object (a union also lends its
 * keys to the object's surface). Only a root with no object anywhere falls
 * back to an empty pass-through object, marked in its description.
 */
export function jsonSchemaToZod(schema: JsonSchema): ToolInputSchema {
  const ctx: Ctx = { root: schema, refs: new Map() };
  let target: JsonSchema = schema;
  for (let i = 0; i < 16 && typeof target.$ref === "string"; i++) {
    const resolved = resolveRef(target.$ref, schema);
    if (!resolved) break;
    target = resolved;
  }
  const converted = convert(target, ctx);

  let object: AnyObject | null = null;
  const rules: z.ZodTypeAny[] = [];
  let foreign = false;
  const absorb = (candidate: AnyObject) => {
    object = object ? mergeObjects(object, candidate) : candidate;
  };
  for (const part of flattenIntersection(converted)) {
    const plain = asObject(part);
    const under = plain ?? objectUnder(part);
    const options = unionOptions(part);
    if (plain) {
      absorb(plain);
    } else if (under) {
      absorb(under);
      rules.push(part);
    } else if (options) {
      const surface = unionSurface(options);
      if (surface) {
        absorb(surface);
        rules.push(part);
      } else {
        foreign = true;
      }
    } else {
      foreign = true;
    }
  }

  let result: AnyObject = object ?? z.object({}).passthrough();
  if (!object) result = markUntranslated(result, "root schema is not an object");
  else if (foreign) result = markUntranslated(result, "root intersects a non-object schema");
  if (converted.description && !result.description) result = result.describe(converted.description);
  if (rules.length === 0) return result;
  return result.superRefine((value, issues) => {
    for (const rule of rules) {
      const parsed = rule.safeParse(value);
      if (!parsed.success) for (const issue of parsed.error.issues) issues.addIssue(issue);
    }
  });
}

/** Convert any JSON Schema fragment; `root` (default: the fragment) resolves local `$ref`s. */
export function jsonSchemaToZodType(schema: JsonSchema, root: JsonSchema = schema): z.ZodTypeAny {
  return convert(schema, { root, refs: new Map() });
}
