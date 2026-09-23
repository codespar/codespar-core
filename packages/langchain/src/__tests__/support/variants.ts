/**
 * Schema variants derived mechanically from any corpus schema, so the
 * differential test reaches shapes nobody wrote a fixture for:
 *
 *   root-ref-with-siblings   the root moved behind `$ref`, with sibling
 *                            properties/required/description beside it;
 *   allOf-strict-default     the root as a strict `allOf` member next to a
 *                            member that defaults a key;
 *   oneOf-strict-default     the root as a strict `oneOf` branch next to
 *                            own properties that default a key;
 *   typeless-values          `type` removed wherever value keywords sit,
 *                            and typeless value-keyword properties added;
 *   nested-allOf-typeless    object properties wrapped in a typeless `allOf`,
 *                            plus a typeless two-member `allOf` property;
 *   array-default-ref-*      an array property whose items are `$ref: "#"`
 *                            and which carries a default (2020-12
 *                            `prefixItems` and draft-07 `additionalItems`);
 *   self-refs                a property that is `$ref: "#"` beside its own
 *                            constraints, and a property referring to its
 *                            parent beside its own constraints.
 */

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Split a root into its definitions and its body. */
function hoist(root: Json): { defs: Json; body: Json } {
  const { $defs, definitions, ...body } = root;
  const defs: Json = {};
  if ($defs !== undefined) defs.$defs = $defs;
  if (definitions !== undefined) defs.definitions = definitions;
  return { defs, body };
}

const VALUE_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
];

/** Remove `type` from every subschema that carries a value keyword. */
function stripValueTypes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripValueTypes);
  if (!isObj(node)) return node;
  const out: Json = {};
  const hasValueKeyword = VALUE_KEYWORDS.some((k) => node[k] !== undefined);
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" && hasValueKeyword && typeof v === "string" && v !== "object") continue;
    // Property names are data, not keywords: recurse into their schemas only.
    out[k] = k === "properties" && isObj(v)
      ? Object.fromEntries(Object.entries(v).map(([n, s]) => [n, stripValueTypes(s)]))
      : stripValueTypes(v);
  }
  return out;
}

function objectProps(root: Json): Json | null {
  return isObj(root.properties) ? (root.properties as Json) : null;
}

export interface Variant {
  kind: string;
  schema: Json;
}

/** Every variant that applies to `root` (an object root with properties). */
export function variants(input: Json): Variant[] {
  const root = clone(input);
  const props = objectProps(root);
  if (!props || typeof root.$ref === "string") return [];
  const { defs, body } = hoist(root);
  const out: Variant[] = [];
  // Moving the body under $defs would break pointers into the root's own properties.
  if (!JSON.stringify(root).includes('"#/properties')) {
    out.push(
      {
        kind: "root-ref-with-siblings",
        schema: {
          ...defs,
          $defs: { ...((defs.$defs as Json) ?? {}), __Root: body },
          $ref: "#/$defs/__Root",
          description: "Root behind a $ref, with siblings",
          properties: { __extra: { type: "string" } },
          required: ["__extra"],
        },
      },
      {
        kind: "allOf-strict-default",
        schema: {
          ...defs,
          allOf: [{ ...body, additionalProperties: false }, { properties: { __d: { type: "number", default: 5 } } }],
        },
      },
      {
        kind: "oneOf-strict-default",
        schema: {
          ...defs,
          type: "object",
          properties: { __d: { type: "number", default: 5 } },
          oneOf: [{ ...body, additionalProperties: false }],
        },
      },
    );
  }

  const typeless = stripValueTypes(root) as Json;
  (typeless.properties as Json).__tn = { minimum: 5, exclusiveMaximum: 100, multipleOf: 5 };
  (typeless.properties as Json).__ts = { minLength: 2, maxLength: 4, pattern: "^a" };
  (typeless.properties as Json).__ta = { minItems: 1, maxItems: 2, uniqueItems: true };
  out.push({ kind: "typeless-values", schema: typeless });

  const nested = clone(root);
  for (const [name, p] of Object.entries(nested.properties as Json)) {
    if (isObj(p) && p.type === "object" && isObj(p.properties)) {
      const { type: _t, ...rest } = p;
      (nested.properties as Json)[name] = { allOf: [rest] };
    }
  }
  (nested.properties as Json).__na = {
    allOf: [{ properties: { x: { type: "string" } }, required: ["x"] }, { properties: { y: { type: "number" } } }],
  };
  out.push({ kind: "nested-allOf-typeless", schema: nested });

  const text = JSON.stringify(root);
  const uses2020 = ["prefixItems", "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems", "minContains", "maxContains", "$dynamicRef"].some((k) => text.includes(`"${k}"`));
  const uses07Arrays = text.includes('"additionalItems"');

  const arrayDefault2020 = clone(root);
  (arrayDefault2020.properties as Json).__arr = { type: "array", prefixItems: [{ $ref: "#" }], default: [{}] };
  if (!uses07Arrays) out.push({ kind: "array-default-ref-2020", schema: arrayDefault2020 });

  const arrayDefault07 = clone(root);
  (arrayDefault07.properties as Json).__arr = {
    type: "array",
    items: [{ type: "string" }],
    additionalItems: { $ref: "#" },
    default: ["a", {}],
  };
  // draft-07's array `items` has no meaning in 2020-12; keep this variant on draft-07.
  if (!uses2020) out.push({ kind: "array-default-ref-07", schema: arrayDefault07 });

  const selfRefs = clone(root);
  const sp = selfRefs.properties as Json;
  sp.__self = { $ref: "#", properties: { __depth: { type: "number" } } };
  sp.__parent = {
    type: "object",
    properties: { k: { type: "string" }, up: { $ref: "#/properties/__parent", required: ["k"] } },
  };
  out.push({ kind: "self-refs", schema: selfRefs });

  return out;
}
