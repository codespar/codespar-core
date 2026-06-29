import { describe, it, expect } from "vitest";
import {
  SHARED_META_TOOL_DEFINITIONS,
  type SharedMetaToolDefinition,
} from "./meta-tool-definitions.js";

const ALL = Object.values(SHARED_META_TOOL_DEFINITIONS) as SharedMetaToolDefinition[];

describe("shared meta-tool definitions", () => {
  it("publishes the demo actions keyed by wire name", () => {
    expect(Object.keys(SHARED_META_TOOL_DEFINITIONS).sort()).toEqual([
      "codespar_invoice",
      "codespar_notify",
      "codespar_pay",
      "codespar_payment_status",
    ]);
  });

  it.each(ALL)("$name carries name, description, input_schema, and contract — all non-empty", (def) => {
    expect(def.name).toMatch(/^codespar_[a-z_]+$/);
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.input_schema.type).toBe("object");
    expect(Object.keys(def.input_schema.properties).length).toBeGreaterThan(0);
    // contract descriptor is non-empty and derived from the schema
    expect(def.contract.properties.length).toBeGreaterThan(0);
    expect(def.contract.required.length).toBeGreaterThan(0);
  });

  it.each(ALL)("$name contract matches its input_schema (no drift)", (def) => {
    expect([...def.contract.properties].sort()).toEqual(
      Object.keys(def.input_schema.properties).sort(),
    );
    expect([...def.contract.required].sort()).toEqual(
      [...(def.input_schema.required ?? [])].sort(),
    );
    // every required field is an advertised property
    for (const r of def.contract.required) {
      expect(def.contract.properties).toContain(r);
    }
  });
});
