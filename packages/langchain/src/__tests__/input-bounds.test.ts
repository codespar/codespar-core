/**
 * Tool-input bounds (input-bounds.ts): an input past them is refused with a
 * clear error before Zod ever parses it, and before anything is sent; an
 * input within them parses exactly as before. The published schema does not
 * change.
 */
import { describe, expect, it, vi } from "vitest";
import type { Session, Tool, ToolResult } from "@codespar/sdk";
import {
  MAX_TOOL_INPUT_COLLECTION_LENGTH,
  MAX_TOOL_INPUT_DEPTH,
  MAX_TOOL_INPUT_SERIALIZED_LENGTH,
  ToolInputTooLargeError,
  boundedToolInput,
  jsonSchemaToZod,
  toLangChainTool,
  toolInputBoundsViolation,
  toolInputObject,
  toolInputShape,
} from "../index.js";

const LIST_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { sku_id: { type: "string" }, quantity: { type: "integer" } }, required: ["sku_id", "quantity"] } },
    note: { type: "string" },
    nested: { type: "object", properties: { lines: { type: "array", items: { type: "string" } } } },
  },
  required: ["items"],
} as const;

function deep(levels: number): Record<string, unknown> {
  let v: Record<string, unknown> = {};
  for (let i = 0; i < levels; i++) v = { d: v };
  return v;
}

function toolWith(schema: unknown): { tool: Tool; executed: string[]; session: Session } {
  const executed: string[] = [];
  const tool: Tool = { name: "codespar_shop", description: "shop", input_schema: schema as Tool["input_schema"], server: "codespar" };
  const session = {
    async execute(name: string): Promise<ToolResult> {
      executed.push(name);
      return { success: true, data: { ok: true }, error: null, duration: 1, server: "codespar", tool: name };
    },
  } as unknown as Session;
  return { tool, executed, session };
}

describe("the bounds themselves", () => {
  it("a huge array at the top is refused, naming where and the limit", () => {
    const v = toolInputBoundsViolation({ items: new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH + 1).fill(1) });
    expect(v).toMatchObject({ limit: "collection_length", path: "$.items", max: MAX_TOOL_INPUT_COLLECTION_LENGTH });
    expect(v!.message).toContain("refused before validation");
  });

  it("a huge array nested deep inside is refused", () => {
    const v = toolInputBoundsViolation({ a: [{ b: { lines: new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH + 5).fill("x") } }] });
    expect(v).toMatchObject({ limit: "collection_length", path: "$.a[0].b.lines" });
  });

  it("an object with too many keys is refused like an array", () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_TOOL_INPUT_COLLECTION_LENGTH + 1 }, (_, i) => [`k${i}`, i]));
    expect(toolInputBoundsViolation({ wide })).toMatchObject({ limit: "collection_length", path: "$.wide" });
  });

  it("nesting past the depth is refused", () => {
    expect(toolInputBoundsViolation(deep(MAX_TOOL_INPUT_DEPTH + 1))).toMatchObject({ limit: "depth" });
  });

  it("a total size past the limit is refused, even with every collection small", () => {
    expect(toolInputBoundsViolation({ note: "x".repeat(MAX_TOOL_INPUT_SERIALIZED_LENGTH + 1) })).toMatchObject({ limit: "serialized_length" });
  });

  it("CONTROL: exactly at the limits fits", () => {
    expect(toolInputBoundsViolation({ items: new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH).fill(1) })).toBeNull();
    expect(toolInputBoundsViolation(deep(MAX_TOOL_INPUT_DEPTH))).toBeNull();
    expect(toolInputBoundsViolation({ note: "x".repeat(MAX_TOOL_INPUT_SERIALIZED_LENGTH - 100) })).toBeNull();
  });
});

describe("the LangChain tool: bounds before Zod and before anything is sent", () => {
  it("a legitimate call parses exactly as the unbounded schema parses it, and runs", async () => {
    const { tool, executed, session } = toolWith(LIST_SCHEMA);
    const lc = toLangChainTool(tool, session);
    const input = { items: [{ sku_id: "cafe-especial-250g", quantity: 2 }], note: "presente", nested: { lines: ["a", "b"] } };
    const bounded = lc.schema.safeParse(input);
    const plain = jsonSchemaToZod(tool.input_schema).safeParse(input);
    expect(bounded.success).toBe(true);
    expect(bounded).toEqual(plain);
    // What the model is shown is the same object, with the same properties.
    expect(Object.keys(toolInputShape(lc.schema))).toEqual(Object.keys(toolInputShape(jsonSchemaToZod(tool.input_schema))));
    await lc.invoke(input);
    expect(executed).toEqual(["codespar_shop"]);
  });

  it("an invalid but small input is still Zod's to refuse, with Zod's own issue", () => {
    const { tool, session } = toolWith(LIST_SCHEMA);
    const r = toLangChainTool(tool, session).schema.safeParse({ items: [] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).not.toContain("refused before validation");
  });

  it("an oversized input is one clear issue from the bounds, never truncated, and invoke sends nothing", async () => {
    const { tool, executed, session } = toolWith(LIST_SCHEMA);
    const lc = toLangChainTool(tool, session);
    const huge = { items: new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH + 1).fill({ sku_id: "x", quantity: 1 }) };
    const r = lc.schema.safeParse(huge);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues).toHaveLength(1);
      expect(r.error.issues[0]).toMatchObject({ code: "custom", params: { limit: "collection_length", at: "$.items" } });
    }
    await expect(lc.invoke(huge)).rejects.toBeInstanceOf(ToolInputTooLargeError);
    expect(executed).toEqual([]);
  });

  it("the bounds run BEFORE Zod: past them, the schema under them never parses the input", () => {
    const { tool, session } = toolWith(LIST_SCHEMA);
    const lc = toLangChainTool(tool, session);
    const parse = vi.spyOn(toolInputObject(lc.schema), "_parse");
    expect(lc.schema.safeParse({ items: new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH + 1) }).success).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    // CONTROL: a small input does reach the schema under the bounds.
    lc.schema.safeParse({ items: [{ sku_id: "a", quantity: 1 }] });
    expect(parse).toHaveBeenCalled();
  });

  it("an input Zod would walk entry by entry (fifty million) is refused cheaply", () => {
    const { tool, session } = toolWith(LIST_SCHEMA);
    const lc = toLangChainTool(tool, session);
    // A sparse array: Zod would visit each entry and record an issue per missing item; the bounds read its length.
    const enormous = { items: new Array(50_000_000) };
    const started = performance.now();
    const r = lc.schema.safeParse(enormous);
    expect(r.success).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("the published schema is unchanged: jsonSchemaToZod itself carries no bounds", () => {
    const plain = jsonSchemaToZod(LIST_SCHEMA as never);
    // Unbounded: the plain conversion parses a large (but valid by its own rules) nested list as it always did.
    const lines = new Array(MAX_TOOL_INPUT_COLLECTION_LENGTH + 1).fill("x");
    expect(plain.safeParse({ items: [{ sku_id: "a", quantity: 1 }], nested: { lines } }).success).toBe(true);
    expect(boundedToolInput(plain).safeParse({ items: [{ sku_id: "a", quantity: 1 }], nested: { lines } }).success).toBe(false);
  });
});
