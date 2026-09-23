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
 * to `z.string()`: it becomes `z.unknown()` with the description marked, so
 * the value reaches the API as sent and the gap is visible in the schema.
 */

import { z } from "zod";

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

function isSchema(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Carry the schema's description over — unless the field already carries one (the untranslated marker). */
function describe<T extends z.ZodTypeAny>(field: T, schema: JsonSchema): T {
  if (field.description !== undefined) return field;
  return typeof schema.description === "string" ? (field.describe(schema.description) as T) : field;
}

/** `z.unknown()` carrying the description plus a marker naming what was not translated. */
function untranslated(schema: JsonSchema, what: string): z.ZodTypeAny {
  const marker = `(schema construct not translated: ${what})`;
  const desc = typeof schema.description === "string" ? `${schema.description} ${marker}` : marker;
  return z.unknown().describe(desc);
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
  // A literal object/array: match by deep equality.
  const want = JSON.stringify(value);
  return z.unknown().refine((v) => JSON.stringify(v) === want, { message: `expected ${want}` });
}

function union(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 0) return z.never();
  if (members.length === 1) return members[0]!;
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
  if (typeof schema.pattern === "string") {
    const re = compilePattern(schema.pattern);
    // A pattern JS cannot compile must not take every tool down with it.
    if (!re) return untranslated(schema, `pattern ${JSON.stringify(schema.pattern)}`);
    s = s.regex(re);
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
  return s;
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
  let a = z.array(isSchema(items) ? convert(items, ctx) : z.unknown());
  if (typeof schema.minItems === "number") a = a.min(schema.minItems);
  if (typeof schema.maxItems === "number") a = a.max(schema.maxItems);
  return a;
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
    const field = isSchema(prop) ? convert(prop, ctx, { skipDefault: isRequired }) : z.unknown();
    const hasDefault = !isRequired && isSchema(prop) && prop.default !== undefined;
    shape[key] = isRequired || hasDefault ? field : field.optional();
  }
  const base = z.object(shape);
  const extra = schema.additionalProperties;
  const object = extra === false ? base.strict() : isSchema(extra) ? base.catchall(convert(extra, ctx)) : base.passthrough();

  // `required` may name keys `properties` does not declare (the "one of
  // these must be present" idiom inside anyOf). Presence is the constraint.
  const undeclared = [...required].filter((k) => !(k in properties));
  if (undeclared.length === 0) return object;
  return object.superRefine((value, issues) => {
    for (const key of undeclared) {
      if (!(key in value)) {
        issues.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Required" });
      }
    }
  });
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
      return untranslated(schema, `type ${JSON.stringify(type)}`);
  }
}

/** Convert any JSON Schema fragment to the Zod type that accepts the same values. */
export function convert(schema: JsonSchema, ctx: Ctx, opts: ConvertOptions = {}): z.ZodTypeAny {
  let field = core(schema, ctx);
  if (schema.nullable === true) field = field.nullable();
  if (schema.default !== undefined && !opts.skipDefault) field = field.default(schema.default as never);
  return describe(field, schema);
}

/** The `$ref` target's Zod type: one instance per target, registered before conversion. */
function reference(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const ref = schema.$ref as string;
  const target = resolveRef(ref, ctx.root);
  if (!target) return untranslated(schema, `$ref ${ref}`);
  const known = ctx.refs.get(target);
  if (known) return known;
  let converted: z.ZodTypeAny | null = null;
  const lazy = z.lazy(() => (converted ??= convert(target, ctx)));
  ctx.refs.set(target, lazy);
  return lazy;
}

/** `anyOf` / `oneOf` / `allOf` as one Zod type, or null when the schema has none. */
function combinator(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny | null {
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as unknown[]).filter(isSchema).map((s) => convert(s, ctx));
    if (parts.length === 0) return z.unknown();
    return parts.slice(1).reduce<z.ZodTypeAny>((acc, p) => z.intersection(acc, p), parts[0]!);
  }
  const alternatives = Array.isArray(schema.anyOf)
    ? (schema.anyOf as unknown[])
    : Array.isArray(schema.oneOf)
      ? (schema.oneOf as unknown[])
      : null;
  if (!alternatives) return null;
  const branches = alternatives.filter(isSchema);
  const nullBranch = branches.some((b) => b.type === "null");
  const rest = branches.filter((b) => b.type !== "null").map((b) => convert(b, ctx));
  const u = rest.length === 0 ? z.null() : union(rest);
  return nullBranch && rest.length > 0 ? u.nullable() : u;
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
  // No type: infer from the keywords present.
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
  for (const keyword of UNTRANSLATED) {
    if (schema[keyword] !== undefined) return untranslated(schema, keyword);
  }
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
  if (combined && own) return z.intersection(own, combined);
  return combined ?? own ?? z.unknown();
}

/**
 * A tool's input schema: the object itself, or the object under a
 * refinement when the root carries a combinator beside its properties
 * (`anyOf: [{ required: [...] }, ...]`). LangChain accepts both forms;
 * {@link toolInputShape} reaches the properties in either.
 */
export type ToolInputSchema =
  | z.ZodObject<z.ZodRawShape>
  | z.ZodEffects<z.ZodObject<z.ZodRawShape>>;

/** The object under a tool input schema, whichever form it takes. */
export function toolInputObject(schema: ToolInputSchema): z.ZodObject<z.ZodRawShape> {
  return schema instanceof z.ZodEffects ? schema.innerType() : schema;
}

/** The properties of a tool input schema, whichever form it takes. */
export function toolInputShape(schema: ToolInputSchema): z.ZodRawShape {
  return toolInputObject(schema).shape;
}

/** Strip the wrappers a converted root may carry to reach the object underneath. */
function unwrapRoot(field: z.ZodTypeAny): z.ZodTypeAny {
  let current = field;
  for (let i = 0; i < 16; i++) {
    if (current instanceof z.ZodLazy) current = current.schema;
    else if (current instanceof z.ZodDefault) current = current._def.innerType;
    else if (current instanceof z.ZodNullable || current instanceof z.ZodOptional) current = current.unwrap();
    else if (current instanceof z.ZodEffects) current = current.innerType();
    else return current;
  }
  return current;
}

/**
 * Convert a tool's `input_schema` (an object schema) to a Zod object schema.
 * A root `$ref` is resolved eagerly and wrappers (default, nullable) are
 * stripped, so a named or wrapped object schema still yields its
 * properties. A root that is an object intersected with a combinator keeps
 * the combinator as a refinement over the object. Only a genuinely
 * non-object root falls back to an empty pass-through object, which keeps
 * LangChain's tool contract.
 */
export function jsonSchemaToZod(schema: JsonSchema): ToolInputSchema {
  const ctx: Ctx = { root: schema, refs: new Map() };
  let target: JsonSchema = schema;
  for (let i = 0; i < 16 && typeof target.$ref === "string"; i++) {
    const resolved = resolveRef(target.$ref, schema);
    if (!resolved) break;
    target = resolved;
  }
  const converted = unwrapRoot(convert(target, ctx));
  if (converted instanceof z.ZodObject) return converted as z.ZodObject<z.ZodRawShape>;
  if (converted instanceof z.ZodIntersection) {
    const left = unwrapRoot(converted._def.left as z.ZodTypeAny);
    const right = converted._def.right as z.ZodTypeAny;
    if (left instanceof z.ZodObject) {
      const object = left as z.ZodObject<z.ZodRawShape>;
      return object.superRefine((value, issues) => {
        const result = right.safeParse(value);
        if (!result.success) for (const issue of result.error.issues) issues.addIssue(issue);
      });
    }
  }
  return z.object({}).passthrough();
}

/** Convert any JSON Schema fragment; `root` (default: the fragment) resolves local `$ref`s. */
export function jsonSchemaToZodType(schema: JsonSchema, root: JsonSchema = schema): z.ZodTypeAny {
  return convert(schema, { root, refs: new Map() });
}
