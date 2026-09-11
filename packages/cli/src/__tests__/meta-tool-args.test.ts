/**
 * The `codespar tool <name>` runner validates against the published
 * definition and nothing else: the property names, the required subset
 * and the closed vocabularies come from `@codespar/types`. These tests
 * read the same definitions the runner reads, so a vocabulary that
 * changes there changes the expectation here too — no rail, action or
 * property name is retyped in this file.
 */

import { describe, expect, it } from "vitest";
import { SHARED_META_TOOL_DEFINITIONS } from "@codespar/sdk";
import { buildArgs, coerceArg, requireDefinition } from "../commands/meta-tool.js";
import { metaToolActions, metaToolNames } from "../surface.js";

const pay = requireDefinition("codespar_pay");
const kyc = requireDefinition("codespar_kyc");
const wallet = requireDefinition("codespar_wallet");

describe("requireDefinition", () => {
  it("resolves every published name and refuses anything else", () => {
    for (const name of Object.keys(SHARED_META_TOOL_DEFINITIONS)) {
      expect(requireDefinition(name).name).toBe(name);
    }
    expect(() => requireDefinition("codespar_made_up")).toThrow(/Unknown meta-tool/);
  });

  it("lists the published tools when the name is wrong", () => {
    try {
      requireDefinition("nope");
      throw new Error("should have thrown");
    } catch (err) {
      for (const name of metaToolNames()) {
        expect((err as Error).message).toContain(name);
      }
    }
  });
});

describe("--action", () => {
  it("accepts every action the definition publishes", () => {
    for (const action of metaToolActions("codespar_wallet")) {
      expect(buildArgs(wallet, undefined, [], action).action).toBe(action);
    }
  });

  it("refuses an action outside the published vocabulary, naming it", () => {
    expect(() => buildArgs(pay, undefined, [], "refund")).toThrow(
      new RegExp(metaToolActions("codespar_pay").join(" \\| ")),
    );
  });

  it("refuses --action for a tool that publishes no action property", () => {
    // codespar_kyc discriminates on check_type; the message must say so
    // instead of silently sending an `action` the router ignores.
    expect(metaToolActions("codespar_kyc")).toEqual([]);
    expect(() => buildArgs(kyc, undefined, [], "status")).toThrow(/publishes no "action"/);
  });
});

describe("--arg", () => {
  it("refuses a property the definition does not publish", () => {
    expect(() => coerceArg(wallet, "not_a_property", "x")).toThrow(/has no property/);
  });

  it("types a value by the published schema", () => {
    const amount = wallet.input_schema.properties.amount;
    expect(amount?.type).toBe("number");
    expect(coerceArg(wallet, "amount", "1500")).toBe(1500);
    expect(() => coerceArg(wallet, "amount", "lots")).toThrow(/expects a number/);
  });

  it("takes JSON for an object-typed property", () => {
    const buyer = kyc.input_schema.properties.buyer;
    expect(buyer?.type).toBe("object");
    expect(coerceArg(kyc, "buyer", '{"name":"Fulano"}')).toEqual({ name: "Fulano" });
    expect(() => coerceArg(kyc, "buyer", "Fulano")).toThrow(/needs valid JSON/);
  });

  it("refuses a value outside a property's published vocabulary", () => {
    const check = kyc.contract.enums?.check_type ?? [];
    expect(check.length).toBeGreaterThan(0);
    expect(coerceArg(kyc, "check_type", check[0]!)).toBe(check[0]);
    expect(() => coerceArg(kyc, "check_type", "vibes")).toThrow(/published vocabulary/);
  });

  it("rejects a pair with no equals sign", () => {
    expect(() => buildArgs(wallet, undefined, ["justakey"], undefined)).toThrow(/key=value/);
  });
});

describe("required input", () => {
  it("refuses to send when a required property is missing, and says how to pass it", () => {
    expect(() => buildArgs(pay, undefined, [], undefined)).toThrow(/Nothing was sent/);
    expect(() => buildArgs(pay, undefined, [], undefined)).toThrow(
      new RegExp(`--action <${metaToolActions("codespar_pay").join("\\|")}>`),
    );
  });

  it("accepts --input as the base and lets --arg and --action override it", () => {
    const args = buildArgs(
      wallet,
      { action: "statement", consumer_id: "con_0000" },
      ["consumer_id=con_1111"],
      "balance",
    );
    expect(args).toEqual({ action: "balance", consumer_id: "con_1111" });
  });

  it("checks every tool's required set against an empty input", () => {
    for (const name of metaToolNames()) {
      const definition = requireDefinition(name);
      if (definition.contract.required.length === 0) {
        expect(buildArgs(definition, undefined, [], undefined)).toEqual({});
        continue;
      }
      expect(() => buildArgs(definition, undefined, [], undefined)).toThrow(
        new RegExp(`requires ${definition.contract.required.join(", ")}`),
      );
    }
  });
});
