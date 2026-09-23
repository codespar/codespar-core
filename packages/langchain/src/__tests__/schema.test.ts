/**
 * JSON Schema → Zod fidelity: one case per construct the converter claims,
 * the fallback for what it does not, and a round trip over real money-tool
 * input schemas proving enum / anyOf / nested fields arrive typed.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  CHARGE_DEFINITION,
  CRYPTO_PAY_DEFINITION,
  PAY_DEFINITION,
  WALLET_DEFINITION,
} from "@codespar/types";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  jsonSchemaToZod,
  jsonSchemaToZodType,
  toolInputShape,
  type JsonSchema,
  type ToolInputSchema,
} from "../schema.js";

const ok = (schema: z.ZodTypeAny, value: unknown) => schema.safeParse(value).success;

function objectWith(prop: JsonSchema, required = true): z.ZodObject<z.ZodRawShape> {
  return jsonSchemaToZod({
    type: "object",
    properties: { v: prop },
    required: required ? ["v"] : [],
  }) as z.ZodObject<z.ZodRawShape>;
}

const shapeOf = (s: ToolInputSchema): z.ZodRawShape => toolInputShape(s);

describe("jsonSchemaToZod — each construct", () => {
  it("enum → closed vocabulary (z.enum), not a free string", () => {
    const s = objectWith({ type: "string", enum: ["pix", "boleto"] });
    expect(shapeOf(s).v).toBeInstanceOf(z.ZodEnum);
    expect(ok(s, { v: "pix" })).toBe(true);
    expect(ok(s, { v: "card" })).toBe(false);
  });

  it("single-value enum and const → literal; mixed enum → union of literals", () => {
    expect(ok(objectWith({ enum: ["only"] }), { v: "only" })).toBe(true);
    expect(ok(objectWith({ enum: ["only"] }), { v: "other" })).toBe(false);
    expect(ok(objectWith({ const: 3 }), { v: 3 })).toBe(true);
    expect(ok(objectWith({ const: 3 }), { v: 4 })).toBe(false);
    const mixed = objectWith({ enum: ["a", 1, null] });
    expect(ok(mixed, { v: 1 })).toBe(true);
    expect(ok(mixed, { v: null })).toBe(true);
    expect(ok(mixed, { v: "b" })).toBe(false);
  });

  it("array items → typed array; tuple items; minItems/maxItems", () => {
    const s = objectWith({ type: "array", items: { type: "number" }, minItems: 1, maxItems: 2 });
    expect(ok(s, { v: [1] })).toBe(true);
    expect(ok(s, { v: ["1"] })).toBe(false);
    expect(ok(s, { v: [] })).toBe(false);
    expect(ok(s, { v: [1, 2, 3] })).toBe(false);
    const t = objectWith({ type: "array", items: [{ type: "string" }, { type: "number" }] });
    expect(ok(t, { v: ["a", 1] })).toBe(true);
    expect(ok(t, { v: [1, "a"] })).toBe(false);
    expect(ok(objectWith({ type: "array" }), { v: [1, "a", null] })).toBe(true);
  });

  it("nested object keeps its own properties and required", () => {
    const s = objectWith({
      type: "object",
      properties: { country: { type: "string" }, name: { type: "string" } },
      required: ["country"],
    });
    expect(shapeOf(s).v).toBeInstanceOf(z.ZodObject);
    expect(ok(s, { v: { country: "BR" } })).toBe(true);
    expect(ok(s, { v: { name: "x" } })).toBe(false);
    expect(ok(s, { v: { country: 1 } })).toBe(false);
  });

  it("additionalProperties: false → strict; a schema → catchall; absent → passthrough", () => {
    const strict = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    });
    expect(ok(strict, { a: "x", b: 1 })).toBe(false);
    const catchall = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: { type: "number" },
    });
    expect(ok(catchall, { a: "x", b: 1 })).toBe(true);
    expect(ok(catchall, { a: "x", b: "no" })).toBe(false);
    const open = jsonSchemaToZod({ type: "object", properties: { a: { type: "string" } } });
    expect(open.parse({ a: "x", extra: true })).toEqual({ a: "x", extra: true });
  });

  it("anyOf / oneOf → union; a null branch → nullable", () => {
    const amount = objectWith({ oneOf: [{ type: "number" }, { type: "string" }] });
    expect(amount.shape.v).toBeInstanceOf(z.ZodUnion);
    expect(ok(amount, { v: 150 })).toBe(true);
    expect(ok(amount, { v: "150.00" })).toBe(true);
    expect(ok(amount, { v: true })).toBe(false);
    const maybe = objectWith({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(ok(maybe, { v: null })).toBe(true);
    expect(ok(maybe, { v: "x" })).toBe(true);
    expect(ok(maybe, { v: 1 })).toBe(false);
  });

  it("allOf → intersection", () => {
    const s = objectWith({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(ok(s, { v: { a: "x", b: 1 } })).toBe(true);
    expect(ok(s, { v: { a: "x" } })).toBe(false);
  });

  it("local $ref is resolved against the root, including a recursive definition", () => {
    const root: JsonSchema = {
      type: "object",
      properties: {
        node: { $ref: "#/definitions/node" },
        addr: { $ref: "#/$defs/addr" },
      },
      required: ["node"],
      definitions: {
        node: {
          type: "object",
          properties: { value: { type: "number" }, next: { $ref: "#/definitions/node" } },
          required: ["value"],
          additionalProperties: false,
        },
      },
      $defs: { addr: { type: "string", format: "email" } },
    };
    const s = jsonSchemaToZod(root);
    expect(ok(s, { node: { value: 1, next: { value: 2 } } })).toBe(true);
    expect(ok(s, { node: { value: 1, next: { value: "2" } } })).toBe(false);
    expect(ok(s, { node: { value: 1 }, addr: "a@b.co" })).toBe(true);
    expect(ok(s, { node: { value: 1 }, addr: "nope" })).toBe(false);
  });

  it("nullable and type: [..., 'null'] → nullable", () => {
    expect(ok(objectWith({ type: "string", nullable: true }), { v: null })).toBe(true);
    const arr = objectWith({ type: ["string", "null"] });
    expect(ok(arr, { v: null })).toBe(true);
    expect(ok(arr, { v: "x" })).toBe(true);
    expect(ok(arr, { v: 1 })).toBe(false);
    expect(ok(objectWith({ type: "string" }), { v: null })).toBe(false);
  });

  it("number/integer with bounds", () => {
    const n = objectWith({ type: "number", minimum: 1, maximum: 10 });
    expect(ok(n, { v: 1.5 })).toBe(true);
    expect(ok(n, { v: 0 })).toBe(false);
    expect(ok(n, { v: 11 })).toBe(false);
    const i = objectWith({ type: "integer", exclusiveMinimum: 0, multipleOf: 5 });
    expect(ok(i, { v: 5 })).toBe(true);
    expect(ok(i, { v: 2.5 })).toBe(false);
    expect(ok(i, { v: 0 })).toBe(false);
    expect(ok(i, { v: 7 })).toBe(false);
  });

  it("string with minLength/maxLength/pattern/format", () => {
    const s = objectWith({ type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" });
    expect(ok(s, { v: "ab" })).toBe(true);
    expect(ok(s, { v: "a" })).toBe(false);
    expect(ok(s, { v: "abcde" })).toBe(false);
    expect(ok(s, { v: "AB" })).toBe(false);
    expect(ok(objectWith({ type: "string", format: "email" }), { v: "x@y.co" })).toBe(true);
    expect(ok(objectWith({ type: "string", format: "email" }), { v: "x" })).toBe(false);
    expect(ok(objectWith({ type: "string", format: "uri" }), { v: "https://x.example/p" })).toBe(true);
    expect(ok(objectWith({ type: "string", format: "uri" }), { v: "x" })).toBe(false);
    expect(ok(objectWith({ type: "string", format: "date-time" }), { v: "2026-09-23T12:00:00-03:00" })).toBe(true);
    expect(ok(objectWith({ type: "string", format: "date-time" }), { v: "yesterday" })).toBe(false);
    expect(ok(objectWith({ type: "string", format: "date" }), { v: "2026-09-23" })).toBe(true);
    expect(ok(objectWith({ type: "string", format: "uuid" }), { v: "not-a-uuid" })).toBe(false);
    // An advisory format is not a constraint.
    expect(ok(objectWith({ type: "string", format: "cpf" }), { v: "anything" })).toBe(true);
  });

  it("default → .default(), and a defaulted property is not required on input", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { country: { type: "string", default: "BR" } },
    });
    expect(s.parse({})).toEqual({ country: "BR" });
    expect(s.parse({ country: "MX" })).toEqual({ country: "MX" });
  });

  it("description is preserved at every level", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: {
        recipient: {
          description: "Who gets paid",
          anyOf: [{ type: "string", description: "A Pix key" }, { type: "object", description: "Bank account" }],
        },
      },
    });
    expect(shapeOf(s).recipient!.description).toBe("Who gets paid");
    const inner = (shapeOf(s).recipient as z.ZodOptional<z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny]>>).unwrap();
    expect(inner.options[0].description).toBe("A Pix key");
    expect(inner.options[1].description).toBe("Bank account");
  });

  it("boolean, null, and an empty schema", () => {
    expect(ok(objectWith({ type: "boolean" }), { v: "true" })).toBe(false);
    expect(ok(objectWith({ type: "null" }), { v: null })).toBe(true);
    expect(ok(objectWith({}), { v: { anything: [1] } })).toBe(true);
  });

  it("an optional property stays optional; a required one does not", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
    expect(ok(s, { a: "x" })).toBe(true);
    expect(ok(s, { b: "x" })).toBe(false);
  });
});

describe("jsonSchemaToZod — review findings", () => {
  const NODE: JsonSchema = {
    type: "object",
    properties: { node: { $ref: "#/definitions/node" } },
    required: ["node"],
    definitions: {
      node: {
        type: "object",
        properties: { value: { type: "number" }, next: { $ref: "#/definitions/node" } },
        required: ["value"],
      },
    },
  };

  it("a recursive $ref resolves to one Zod instance, so a walk of the tree (zod-to-json-schema) terminates", () => {
    const s = jsonSchemaToZod(NODE);
    const next = (shapeOf(s).node as z.ZodLazy<z.ZodTypeAny>).schema;
    const inner = (next as z.ZodObject<z.ZodRawShape>).shape.next as z.ZodOptional<z.ZodLazy<z.ZodTypeAny>>;
    expect(inner.unwrap()).toBe(shapeOf(s).node);
    expect(inner.unwrap().schema).toBe(next);
    const out = zodToJsonSchema(s);
    expect(JSON.stringify(out)).toContain("$ref");
    expect(ok(s, { node: { value: 1, next: { value: 2, next: { value: 3 } } } })).toBe(true);
    expect(ok(s, { node: { value: 1, next: { value: "2" } } })).toBe(false);
  });

  it("a pattern JS cannot compile marks the field untranslated instead of throwing", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        ok: { type: "string", pattern: "^[a-z]+$" },
        bad: { type: "string", pattern: "(?P<name>a)", description: "Python named group" },
      },
      required: ["ok", "bad"],
    };
    expect(() => jsonSchemaToZod(schema)).not.toThrow();
    const s = jsonSchemaToZod(schema);
    expect(shapeOf(s).bad).toBeInstanceOf(z.ZodUnknown);
    expect(shapeOf(s).bad!.description).toContain("schema construct not translated: pattern");
    expect(ok(s, { ok: "abc", bad: "anything" })).toBe(true);
    expect(ok(s, { ok: "ABC", bad: "anything" })).toBe(false);
  });

  it("a root $ref, default, nullable or effects wrapper still yields the object's properties", () => {
    const named = jsonSchemaToZod({
      $ref: "#/definitions/Input",
      definitions: {
        Input: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      },
    });
    expect(Object.keys(shapeOf(named))).toEqual(["amount"]);
    expect(ok(named, { amount: "x" })).toBe(false);
    const defaulted = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      default: { a: "x" },
      nullable: true,
    });
    expect(Object.keys(shapeOf(defaulted))).toEqual(["a"]);
    const withUndeclaredRequired = jsonSchemaToZod({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    });
    expect(Object.keys(shapeOf(withUndeclaredRequired))).toEqual(["a"]);
    // A genuinely non-object root is the empty pass-through object.
    expect(Object.keys(shapeOf(jsonSchemaToZod({ type: "string" })))).toEqual([]);
  });

  it("anyOf beside type: object + properties constrains the object instead of replacing it", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { pix_key: { type: "string" }, account: { type: "object" }, v: { type: "number" } },
      required: ["v"],
      anyOf: [{ required: ["pix_key"] }, { required: ["account"] }],
    });
    // The properties are still reachable; the combinator rides as a refinement.
    expect(s).toBeInstanceOf(z.ZodEffects);
    expect(Object.keys(shapeOf(s))).toEqual(["pix_key", "account", "v"]);
    expect(ok(s, { v: 1, pix_key: "a@b.co" })).toBe(true);
    expect(ok(s, { v: 1, account: {} })).toBe(true);
    expect(ok(s, { v: 1 })).toBe(false);
    expect(ok(s, { v: 1, pix_key: 5 })).toBe(false);
    expect(ok(s, { pix_key: "a@b.co" })).toBe(false);
    const all = objectWith({
      type: "object",
      properties: { a: { type: "string" } },
      allOf: [{ required: ["a"] }],
    });
    expect(ok(all, { v: { a: "x" } })).toBe(true);
    expect(ok(all, { v: {} })).toBe(false);
  });

  it("a required property keeps its default out of the type: it must be sent", () => {
    const s = jsonSchemaToZod({
      type: "object",
      properties: { country: { type: "string", default: "BR" }, currency: { type: "string", default: "BRL" } },
      required: ["country"],
    });
    expect(ok(s, {})).toBe(false);
    expect(s.parse({ country: "MX" })).toEqual({ country: "MX", currency: "BRL" });
  });

  it("prefixItems → tuple with the items schema as rest, closed by items: false", () => {
    const open = objectWith({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] });
    expect(ok(open, { v: ["a", 1] })).toBe(true);
    expect(ok(open, { v: ["a", 1, true] })).toBe(true);
    expect(ok(open, { v: [1, "a"] })).toBe(false);
    const typedRest = objectWith({ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } });
    expect(ok(typedRest, { v: ["a", 1, 2] })).toBe(true);
    expect(ok(typedRest, { v: ["a", "b"] })).toBe(false);
    const closed = objectWith({ type: "array", prefixItems: [{ type: "string" }], items: false });
    expect(ok(closed, { v: ["a"] })).toBe(true);
    expect(ok(closed, { v: ["a", 1] })).toBe(false);
    // draft-07 spelling, same semantics via additionalItems.
    const d7 = objectWith({ type: "array", items: [{ type: "string" }], additionalItems: false });
    expect(ok(d7, { v: ["a", 1] })).toBe(false);
    expect(ok(objectWith({ type: "array", items: [{ type: "string" }] }), { v: ["a", 1] })).toBe(true);
  });

  it("draft-4 boolean exclusiveMinimum/exclusiveMaximum make the bound exclusive", () => {
    const s = objectWith({ type: "number", minimum: 0, exclusiveMinimum: true, maximum: 10, exclusiveMaximum: true });
    expect(ok(s, { v: 0 })).toBe(false);
    expect(ok(s, { v: 10 })).toBe(false);
    expect(ok(s, { v: 5 })).toBe(true);
    const inclusive = objectWith({ type: "number", minimum: 0, exclusiveMinimum: false });
    expect(ok(inclusive, { v: 0 })).toBe(true);
  });
});

describe("jsonSchemaToZod — what it does not translate", () => {
  it.each([
    ["not", { not: { type: "string" } }],
    ["if", { if: { type: "string" }, then: { minLength: 1 } }],
    ["patternProperties", { type: "object", patternProperties: { "^x": { type: "string" } } }],
    ["$ref https://…", { $ref: "https://example.com/schema.json" }],
    ["$ref #/missing", { $ref: "#/definitions/missing" }],
    ["type \"money\"", { type: "money" }],
  ])("%s → z.unknown() with the description marked, never z.string()", (_label, prop) => {
    const s = objectWith({ description: "The amount", ...(prop as JsonSchema) });
    const field = shapeOf(s).v!;
    expect(field).toBeInstanceOf(z.ZodUnknown);
    expect(field).not.toBeInstanceOf(z.ZodString);
    expect(field.description).toMatch(/^The amount \(schema construct not translated: /);
    // Whatever the model sends reaches the API as sent.
    expect(ok(s, { v: { nested: [1, "two"] } })).toBe(true);
    expect(ok(s, { v: 42 })).toBe(true);
  });

  it("a non-object root still yields an object schema for the tool contract", () => {
    const s = jsonSchemaToZod({ type: "string" });
    expect(s).toBeInstanceOf(z.ZodObject);
    expect(ok(s, { anything: 1 })).toBe(true);
  });

  it("jsonSchemaToZodType converts a fragment with an explicit root for $ref", () => {
    const root: JsonSchema = { $defs: { id: { type: "string", pattern: "^pay_" } } };
    const t = jsonSchemaToZodType({ $ref: "#/$defs/id" }, root);
    expect(ok(t, "pay_1")).toBe(true);
    expect(ok(t, "x")).toBe(false);
  });
});

describe("round trip over real money-tool input schemas", () => {
  const pay = jsonSchemaToZod(PAY_DEFINITION.input_schema as unknown as JsonSchema);
  const charge = jsonSchemaToZod(CHARGE_DEFINITION.input_schema as unknown as JsonSchema);
  const crypto = jsonSchemaToZod(CRYPTO_PAY_DEFINITION.input_schema as unknown as JsonSchema);
  const wallet = jsonSchemaToZod(WALLET_DEFINITION.input_schema as unknown as JsonSchema);

  it("codespar_pay: action and method are closed vocabularies", () => {
    expect(shapeOf(pay).action).toBeDefined();
    expect(ok(pay, { action: "pay", amount: 15000, currency: "BRL", method: "pix", recipient: "a@b.co" })).toBe(true);
    expect(ok(pay, { action: "refund", amount: 15000, currency: "BRL", method: "pix", recipient: "a@b.co" })).toBe(false);
    expect(ok(pay, { action: "pay", amount: 15000, currency: "BRL", method: "cash", recipient: "a@b.co" })).toBe(false);
  });

  it("codespar_pay: recipient is the anyOf — a Pix key string OR a bank-account object, not a string", () => {
    const recipient = (shapeOf(pay).recipient as z.ZodOptional<z.ZodTypeAny>).unwrap();
    expect(recipient).toBeInstanceOf(z.ZodUnion);
    expect(ok(pay, { action: "pay", recipient: "11144477735" })).toBe(true);
    const branch = (PAY_DEFINITION.input_schema.properties.recipient.anyOf ?? []).find((b) => b.type === "object");
    const required = Object.keys(branch?.properties ?? {});
    const account = Object.fromEntries(required.map((k) => [k, "x"]));
    expect(ok(pay, { action: "pay", recipient: account })).toBe(true);
    expect(ok(pay, { action: "pay", recipient: 123 })).toBe(false);
  });

  it("codespar_charge: method enum is enforced, amount must be a number, buyer must be an object", () => {
    const methods = CHARGE_DEFINITION.input_schema.properties.method.enum ?? [];
    expect(methods.length).toBeGreaterThan(0);
    const base = { amount: 15000, currency: "BRL", description: "Order 42", buyer: { name: "Ana" } };
    expect(ok(charge, { ...base, method: methods[0] })).toBe(true);
    expect(ok(charge, { ...base, method: "cheque" })).toBe(false);
    expect(ok(charge, { ...base, method: methods[0], amount: "15000" })).toBe(false);
    expect(ok(charge, { ...base, method: methods[0], buyer: "Ana" })).toBe(false);
    // Every declared required field is required after conversion, too.
    expect(ok(charge, { amount: 15000, currency: "BRL", method: methods[0] })).toBe(false);
  });

  it("codespar_crypto_pay: enums at the top level, and counterparty is a typed nested object", () => {
    const { currency, direction, network } = CRYPTO_PAY_DEFINITION.input_schema.properties;
    const base = { amount: 10, currency: currency.enum![0], direction: direction.enum![0] };
    expect(ok(crypto, base)).toBe(true);
    expect(ok(crypto, { ...base, currency: "BRL" })).toBe(false);
    expect(ok(crypto, { ...base, network: network.enum![0] })).toBe(true);
    expect(ok(crypto, { ...base, network: "mainnet" })).toBe(false);
    const field = (shapeOf(crypto).counterparty as z.ZodOptional<z.ZodTypeAny>).unwrap();
    expect(field).toBeInstanceOf(z.ZodObject);
    expect((field as z.ZodObject<z.ZodRawShape>).shape.country).toBeInstanceOf(z.ZodOptional);
    expect(ok(crypto, { ...base, counterparty: { country: "BR" } })).toBe(true);
    expect(ok(crypto, { ...base, counterparty: { country: 55 } })).toBe(false);
    expect(ok(crypto, { ...base, counterparty: "BR" })).toBe(false);
  });

  it("codespar_wallet: every declared property converts and the schema has no z.string() stand-ins", () => {
    for (const [key, prop] of Object.entries(WALLET_DEFINITION.input_schema.properties)) {
      const field = shapeOf(wallet)[key]!;
      const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
      if (prop.enum) expect(inner, key).toBeInstanceOf(prop.enum.length === 1 ? z.ZodLiteral : z.ZodEnum);
      else if (prop.type === "number") expect(inner, key).toBeInstanceOf(z.ZodNumber);
      else if (prop.type === "boolean") expect(inner, key).toBeInstanceOf(z.ZodBoolean);
      else if (prop.type === "object") expect(inner, key).toBeInstanceOf(z.ZodObject);
      else if (prop.type === "array") expect(inner, key).toBeInstanceOf(z.ZodArray);
    }
  });

  it("no real tool schema produces an untranslated marker", () => {
    for (const def of [PAY_DEFINITION, CHARGE_DEFINITION, CRYPTO_PAY_DEFINITION, WALLET_DEFINITION]) {
      const s = jsonSchemaToZod(def.input_schema as unknown as JsonSchema);
      const walk = (t: z.ZodTypeAny): void => {
        expect(t.description ?? "", def.name).not.toContain("schema construct not translated");
        if (t instanceof z.ZodOptional || t instanceof z.ZodNullable || t instanceof z.ZodDefault) walk(t._def.innerType);
        else if (t instanceof z.ZodObject) for (const v of Object.values(t.shape)) walk(v as z.ZodTypeAny);
        else if (t instanceof z.ZodUnion) for (const v of t.options) walk(v);
        else if (t instanceof z.ZodArray) walk(t.element);
      };
      walk(s);
    }
  });
});
