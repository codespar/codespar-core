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

describe("codespar pay --arg idempotency_key (codespar-enterprise#1752)", () => {
  // The API refuses a boleto pay without an idempotency key
  // (boleto_idempotency_key_required). `--arg` accepts only the names the
  // published codespar_pay definition declares, so until @codespar/types
  // published the key, `codespar pay --arg method=boleto ...` had no way to
  // carry it except by switching to --input.
  const boleto = [
    "method=boleto",
    "amount=12500",
    "currency=BRL",
    "description=Conta de luz",
    "linha_digitavel=34191790010104351004791020150008291070026000",
  ];

  it("sends the key with a boleto pay built from --arg alone", () => {
    const args = buildArgs(pay, undefined, [...boleto, "idempotency_key=boleto-2026-09-26-001"], "pay");
    expect(args).toMatchObject({
      action: "pay",
      method: "boleto",
      amount: 12500,
      idempotency_key: "boleto-2026-09-26-001",
    });
  });

  it("keeps a key that looks like a number as the string it is", () => {
    // A key built from a timestamp or an invoice number is all digits; the
    // published type is string, and the dedupe anchor must match verbatim on
    // the retry, so it must not become a number (or lose leading zeros).
    expect(coerceArg(pay, "idempotency_key", "0012345678901234567890")).toBe("0012345678901234567890");
  });

  it("still refuses a property codespar_pay does not publish (control)", () => {
    // Same flag, same tool, a name one character off: the check that let the
    // key through is still the published-name check, not a hole in it.
    expect(() => buildArgs(pay, undefined, [...boleto, "idempotency_keys=k"], "pay")).toThrow(
      /codespar_pay has no property "idempotency_keys"/,
    );
    expect(() => coerceArg(pay, "not_a_property", "x")).toThrow(/idempotency_key/);
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

describe("a property that publishes a union of shapes (core#128)", () => {
  // `codespar_pay.recipient` takes either a Pix key string or a bank-account
  // object. It used to be published as `type: "string"` with a description
  // telling the caller to pass an object, so a client that enforced the schema
  // rejected the correct call. The union is now in the schema, and the CLI has
  // to accept both forms through the same flag.
  const recipient = pay.input_schema.properties.recipient!;

  it("is published as a union and not as one type", () => {
    expect(recipient.type).toBeUndefined();
    expect(recipient.anyOf?.map((b) => b.type).sort()).toEqual(["object", "string"]);
  });

  it("keeps a Pix key as the string it is", () => {
    // A CPF key is all digits and must not become a number, and an EVP is not
    // JSON. Both stay text.
    expect(coerceArg(pay, "recipient", "pix@example.com")).toBe("pix@example.com");
    expect(coerceArg(pay, "recipient", "12345678901")).toBe("12345678901");
    expect(coerceArg(pay, "recipient", "b5b8e0f4-0000-4000-8000-000000000000")).toBe(
      "b5b8e0f4-0000-4000-8000-000000000000",
    );
  });

  it("parses the bank-account object the other branch declares", () => {
    const account = {
      bank: "60701190",
      account: "12345678",
      branch: "0001",
      tax_id: "12345678901",
      name: "Fulana de Tal",
      account_type: "CACC",
    };
    expect(coerceArg(pay, "recipient", JSON.stringify(account))).toEqual(account);
  });

  it("builds the whole call with either form", () => {
    const viaKey = buildArgs(pay, undefined, ["recipient=pix@example.com"], "pay");
    expect(viaKey.recipient).toBe("pix@example.com");
    const viaAccount = buildArgs(
      pay,
      undefined,
      ['recipient={"bank":"60701190","account":"12345678","branch":"0001"}'],
      "pay",
    );
    expect(viaAccount.recipient).toMatchObject({ bank: "60701190" });
  });
});
