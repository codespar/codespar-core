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

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object"]);

interface Ctx {
  /** The root schema, for local `$ref` resolution. */
  root: JsonSchema;
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

function stringSchema(schema: JsonSchema): z.ZodTypeAny {
  let s = z.string();
  if (typeof schema.minLength === "number") s = s.min(schema.minLength);
  if (typeof schema.maxLength === "number") s = s.max(schema.maxLength);
  if (typeof schema.pattern === "string") {
    try {
      s = s.regex(new RegExp(schema.pattern, "u"));
    } catch {
      s = s.regex(new RegExp(schema.pattern));
    }
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
  if (typeof schema.minimum === "number") n = n.min(schema.minimum);
  if (typeof schema.maximum === "number") n = n.max(schema.maximum);
  if (typeof schema.exclusiveMinimum === "number") n = n.gt(schema.exclusiveMinimum);
  if (typeof schema.exclusiveMaximum === "number") n = n.lt(schema.exclusiveMaximum);
  if (typeof schema.multipleOf === "number") n = n.multipleOf(schema.multipleOf);
  return n;
}

function arraySchema(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  const items = schema.items;
  if (Array.isArray(items)) {
    const members = items.map((it) => (isSchema(it) ? convert(it, ctx) : z.unknown()));
    return members.length === 0 ? z.tuple([]) : z.tuple([members[0]!, ...members.slice(1)]);
  }
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
function objectSchema(schema: JsonSchema, ctx: Ctx): z.ZodObject<z.ZodRawShape> {
  const properties = isSchema(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  const shape: z.ZodRawShape = {};
  for (const [key, prop] of Object.entries(properties)) {
    const field = isSchema(prop) ? convert(prop, ctx) : z.unknown();
    const hasDefault = isSchema(prop) && prop.default !== undefined;
    shape[key] = required.has(key) || hasDefault ? field : field.optional();
  }
  const base = z.object(shape);
  const extra = schema.additionalProperties;
  if (extra === false) return base.strict();
  if (isSchema(extra)) return base.catchall(convert(extra, ctx));
  return base.passthrough();
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
export function convert(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  let field = core(schema, ctx);
  if (schema.nullable === true) field = field.nullable();
  if (schema.default !== undefined) field = field.default(schema.default as never);
  return describe(field, schema);
}

function core(schema: JsonSchema, ctx: Ctx): z.ZodTypeAny {
  for (const keyword of UNTRANSLATED) {
    if (schema[keyword] !== undefined) return untranslated(schema, keyword);
  }

  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    const target = resolveRef(ref, ctx.root);
    if (!target) return untranslated(schema, `$ref ${ref}`);
    // Lazy so a self-referencing definition terminates at conversion time.
    return z.lazy(() => convert(target, ctx));
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
    return union(values.map(literal));
  }

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
  if (alternatives) {
    const branches = alternatives.filter(isSchema);
    const nullBranch = branches.some((b) => b.type === "null");
    const rest = branches.filter((b) => b.type !== "null").map((b) => convert(b, ctx));
    const u = rest.length === 0 ? z.null() : union(rest);
    return nullBranch && rest.length > 0 ? u.nullable() : u;
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    const types = (type as unknown[]).filter((t): t is string => typeof t === "string");
    const nullable = types.includes("null");
    const rest = types.filter((t) => t !== "null").map((t) => byType(t, schema, ctx));
    if (rest.length === 0) return z.null();
    const u = union(rest);
    return nullable ? u.nullable() : u;
  }
  if (typeof type === "string") {
    if (!PRIMITIVE_TYPES.has(type)) return untranslated(schema, `type ${JSON.stringify(type)}`);
    return byType(type, schema, ctx);
  }

  // No type: infer from the keywords present, else the schema accepts anything.
  if (isSchema(schema.properties) || schema.additionalProperties !== undefined) {
    return objectSchema(schema, ctx);
  }
  if (schema.items !== undefined) return arraySchema(schema, ctx);
  return z.unknown();
}

/**
 * Convert a tool's `input_schema` (an object schema) to a Zod object schema.
 * A non-object root is still returned as an object so LangChain's tool
 * contract holds; its properties are then empty and unknown keys pass.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodObject<z.ZodRawShape> {
  const ctx: Ctx = { root: schema };
  const converted = convert(schema, ctx);
  return converted instanceof z.ZodObject
    ? (converted as z.ZodObject<z.ZodRawShape>)
    : z.object({}).passthrough();
}

/** Convert any JSON Schema fragment; `root` (default: the fragment) resolves local `$ref`s. */
export function jsonSchemaToZodType(schema: JsonSchema, root: JsonSchema = schema): z.ZodTypeAny {
  return convert(schema, { root });
}
