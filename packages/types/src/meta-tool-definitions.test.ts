import { describe, it, expect } from "vitest";
import {
  SHARED_META_TOOL_DEFINITIONS,
  contractOf,
  type MetaToolInputSchema,
  type SharedMetaToolDefinition,
} from "./meta-tool-definitions.js";
import {
  definitionViolations,
  sharedDefinitionConformanceReasons,
  type AgentFacingToolShape,
} from "./meta-tool-definition-conformance.js";

const ALL = Object.values(SHARED_META_TOOL_DEFINITIONS) as SharedMetaToolDefinition[];

/** Tools whose input schema is an empty object by design (no arguments). */
const NO_ARG_TOOLS = new Set(["codespar_get_started"]);

function defWith(overrides: {
  name?: string;
  description?: string;
  input_schema: MetaToolInputSchema;
  contract?: SharedMetaToolDefinition["contract"];
}): SharedMetaToolDefinition {
  return {
    name: overrides.name ?? "codespar_fake",
    description: overrides.description ?? "A fabricated definition for tripwire tests.",
    input_schema: overrides.input_schema,
    contract: overrides.contract ?? contractOf(overrides.input_schema),
  };
}

describe("shared meta-tool definitions", () => {
  it("publishes ALL fifteen meta-tools keyed by wire name (ent#933: was 3 of 15)", () => {
    expect(Object.keys(SHARED_META_TOOL_DEFINITIONS).sort()).toEqual([
      "codespar_charge",
      "codespar_checkout",
      "codespar_crypto_pay",
      "codespar_discover",
      "codespar_get_started",
      "codespar_invoice",
      "codespar_issue",
      "codespar_kyc",
      "codespar_ledger",
      "codespar_manage_connections",
      "codespar_notify",
      "codespar_pay",
      "codespar_ship",
      "codespar_shop",
      "codespar_wallet",
    ]);
  });

  it.each(ALL)("$name carries name, description, input_schema, and contract — all well-formed", (def) => {
    expect(def.name).toMatch(/^codespar_[a-z][a-z_]*$/);
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.input_schema.type).toBe("object");
    if (!NO_ARG_TOOLS.has(def.name)) {
      expect(Object.keys(def.input_schema.properties).length).toBeGreaterThan(0);
      expect(def.contract.properties.length).toBeGreaterThan(0);
    }
    // the map key is the wire name
    expect(SHARED_META_TOOL_DEFINITIONS[def.name as keyof typeof SHARED_META_TOOL_DEFINITIONS]).toBe(def);
  });

  it.each(ALL)(
    "$name passes the full definition check: contract matches schema, enums are visible in prose, no ghost rails",
    (def) => {
      const violations = definitionViolations(def);
      expect(violations.map((v) => `[${v.code}] ${v.detail}`).join("; ")).toBe("");
    },
  );

  it("codespar_pay publishes the ent#932 vocabulary: pix/card/boleto/wire, no sepa/usdc/ted", () => {
    const pay = SHARED_META_TOOL_DEFINITIONS.codespar_pay;
    // The rail vocabulary is a STRUCTURED enum, not prose — pinned exactly.
    expect(pay.input_schema.properties.method!.enum).toEqual(["pix", "card", "boleto", "wire"]);
    expect(pay.contract.enums?.method).toEqual(["pix", "card", "boleto", "wire"]);
    // The shared baseline action vocabulary (managed-only extras like
    // boleto_quote and the DICT lifecycle are deliberately NOT here).
    expect(pay.input_schema.properties.action!.enum).toEqual(["pay", "status"]);
    expect(pay.input_schema.required).toEqual(["action"]);
    // The shared property surface, pinned: adding or dropping one is a
    // contract change, not a drive-by.
    expect(Object.keys(pay.input_schema.properties)).toEqual([
      "action",
      "amount",
      "currency",
      "country",
      "method",
      "recipient",
      "copia_e_cola",
      "consumer_id",
      "checkout_session_id",
      "description",
      "mandateId",
      "payment_id",
      "linha_digitavel",
    ]);
  });

  it("codespar_pay publishes the recipient-as-object capability (ent#933 drift 1)", () => {
    // The runtime accepts `recipient` as a bank-account OBJECT (manual Pix
    // cash-out to a destination with no registered key). The published
    // definition must say so — this pin keeps the capability from silently
    // falling back out of the contract.
    const recipient = SHARED_META_TOOL_DEFINITIONS.codespar_pay.input_schema.properties.recipient!;
    expect(recipient.description).toMatch(/object with bank-account details/i);
    expect(recipient.description).toMatch(/\{bank, account, branch, tax_id, name, account_type\?\}/);
  });

  it("codespar_wallet and codespar_kyc have published definitions with their vocabularies (ent#933 drift 3)", () => {
    // The two tools the audit named as having NO published definition at all.
    const wallet = SHARED_META_TOOL_DEFINITIONS.codespar_wallet;
    expect(wallet.input_schema.properties.action!.enum).toEqual(["balance", "statement", "receive"]);
    expect(wallet.input_schema.required).toEqual(["action"]);

    const kyc = SHARED_META_TOOL_DEFINITIONS.codespar_kyc;
    expect(kyc.input_schema.properties.check_type!.enum).toEqual([
      "identity",
      "document",
      "risk-score",
      "sanctions",
      "onboarding",
      "onboarding-business",
      "status",
    ]);
    expect(kyc.input_schema.required).toEqual(["buyer", "check_type"]);
  });
});

describe("definitionViolations tripwires (the checks must FAIL on the drift they claim to catch)", () => {
  it("prose advertising a retired rail fails, even though the structural surface is clean", () => {
    const def = defWith({
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", description: "Payment method: pix, sepa", enum: ["pix"] },
        },
        required: ["method"],
      },
    });
    const violations = definitionViolations(def);
    expect(violations.some((v) => v.code === "ghost-rail" && v.detail.includes('"sepa"'))).toBe(true);
  });

  it("the pre-#932 published pay prose (usdc + sepa rails) would have been flagged", () => {
    // Regression pin: this is the EXACT drift the audit found — the old
    // published codespar_pay advertised rails in prose that routed nowhere,
    // and the old conformance check ('structural, not prose') stayed green.
    const def = defWith({
      name: "codespar_pay",
      input_schema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            description:
              "Payment method: pix, card, usdc, boleto, sepa, wire. method=boleto pays/settles an EXISTING boleto (provide linha_digitavel); it does not issue new boleto charges.",
          },
        },
      },
    });
    const violations = definitionViolations(def);
    expect(violations.some((v) => v.detail.includes('"sepa"'))).toBe(true);
    expect(violations.some((v) => v.detail.includes('"usdc"'))).toBe(true);
  });

  it("usdc inside a codespar_crypto_pay redirect sentence passes (positive control)", () => {
    const def = defWith({
      input_schema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            description: "Payment method: pix. For USDC or any on-chain settlement use codespar_crypto_pay.",
            enum: ["pix"],
          },
        },
      },
    });
    expect(definitionViolations(def)).toEqual([]);
  });

  it("usdc owned by a structured enum passes (positive control: the crypto tool names its own rail)", () => {
    const def = defWith({
      input_schema: {
        type: "object",
        properties: {
          currency: { type: "string", description: "Crypto currency code: USDC, USDT", enum: ["USDC", "USDT"] },
        },
      },
    });
    expect(definitionViolations(def)).toEqual([]);
  });

  it("an enum value invisible in the property's prose fails (schema and prose must agree)", () => {
    const def = defWith({
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", description: "balance | statement", enum: ["balance", "statement", "receive"] },
        },
      },
    });
    const violations = definitionViolations(def);
    expect(violations.some((v) => v.code === "enum-prose" && v.detail.includes('"receive"'))).toBe(true);
  });

  it("a hand-drifted contract fails: schema enum not mirrored, phantom property, phantom vocabulary", () => {
    const schema: MetaToolInputSchema = {
      type: "object",
      properties: {
        action: { type: "string", description: "a | b", enum: ["a", "b"] },
      },
      required: ["action"],
    };
    const def = defWith({
      input_schema: schema,
      contract: {
        properties: ["action", "phantom"],
        required: ["action"],
        enums: { phantom: ["x"] },
      },
    });
    const violations = definitionViolations(def).filter((v) => v.code === "contract-drift");
    expect(violations.some((v) => v.detail.includes("contract.properties"))).toBe(true);
    expect(violations.some((v) => v.detail.includes('schema enum on "action" is not mirrored'))).toBe(true);
    expect(violations.some((v) => v.detail.includes('contract.enums["phantom"]'))).toBe(true);
  });
});

describe("sharedDefinitionConformanceReasons (the cross-runtime comparator sees enums and embedded shapes)", () => {
  const shared = SHARED_META_TOOL_DEFINITIONS.codespar_pay;

  /** A runtime tool that mirrors the shared definition exactly. */
  function conformingTool(): AgentFacingToolShape {
    return {
      name: shared.name,
      description: shared.description,
      input_schema: {
        type: "object",
        properties: JSON.parse(JSON.stringify(shared.input_schema.properties)) as Record<string, unknown>,
        required: [...(shared.input_schema.required ?? [])],
      },
    };
  }

  it("a mirroring runtime tool passes with zero reasons (positive control)", () => {
    expect(sharedDefinitionConformanceReasons(conformingTool(), shared)).toEqual([]);
  });

  it("an allowlisted extra property passes; an unlisted one fails", () => {
    const tool = conformingTool();
    tool.input_schema.properties.expected_amount_minor = { type: "number", description: "managed-only" };
    expect(
      sharedDefinitionConformanceReasons(tool, shared, new Set(["expected_amount_minor"])),
    ).toEqual([]);
    expect(
      sharedDefinitionConformanceReasons(tool, shared).some((r) =>
        r.includes("expected_amount_minor"),
      ),
    ).toBe(true);
  });

  it("a missing shared property and a divergent property type fail", () => {
    const missing = conformingTool();
    delete (missing.input_schema.properties as Record<string, unknown>).recipient;
    expect(
      sharedDefinitionConformanceReasons(missing, shared).some((r) => r.includes("missing shared properties [recipient]")),
    ).toBe(true);

    const flipped = conformingTool();
    (flipped.input_schema.properties.amount as { type: string }).type = "string";
    expect(
      sharedDefinitionConformanceReasons(flipped, shared).some((r) => r.includes('property "amount" type')),
    ).toBe(true);
  });

  it("a runtime enum that DROPS a shared vocabulary value fails (ent#933: vocabularies are compared, not prose-trusted)", () => {
    const tool = conformingTool();
    (tool.input_schema.properties.method as { enum: string[] }).enum = ["pix", "card", "boleto"]; // drops wire
    expect(
      sharedDefinitionConformanceReasons(tool, shared).some((r) =>
        r.includes('property "method" enum drops shared values [wire]'),
      ),
    ).toBe(true);
  });

  it("a runtime enum that EXTENDS the shared vocabulary passes (managed runtimes may extend, never shrink)", () => {
    const tool = conformingTool();
    const action = tool.input_schema.properties.action as { enum: string[]; description: string };
    action.enum = [...action.enum, "boleto_quote"];
    action.description += " | boleto_quote (managed-only)";
    expect(sharedDefinitionConformanceReasons(tool, shared)).toEqual([]);
  });

  it("runtime prose that HIDES a shared vocabulary value fails", () => {
    const tool = conformingTool();
    const method = tool.input_schema.properties.method as { description: string };
    method.description = "Payment method: pix, card, boleto."; // prose hides wire
    expect(
      sharedDefinitionConformanceReasons(tool, shared).some((r) =>
        r.includes('property "method" prose hides the shared vocabulary value "wire"'),
      ),
    ).toBe(true);
  });

  it("runtime prose advertising a retired rail fails — the pre-#932 TED-in-recipient drift is now caught", () => {
    const tool = conformingTool();
    const recipient = tool.input_schema.properties.recipient as { description: string };
    recipient.description += " Also accepts a TED bank transfer destination.";
    expect(
      sharedDefinitionConformanceReasons(tool, shared).some((r) => r.includes('"ted"')),
    ).toBe(true);
  });

  it("a shared embedded shape must be honored: missing or type-divergent nested property fails", () => {
    const cryptoShared = SHARED_META_TOOL_DEFINITIONS.codespar_crypto_pay;
    const tool: AgentFacingToolShape = {
      name: cryptoShared.name,
      input_schema: {
        type: "object",
        properties: JSON.parse(JSON.stringify(cryptoShared.input_schema.properties)) as Record<string, unknown>,
        required: [...(cryptoShared.input_schema.required ?? [])],
      },
    };
    expect(sharedDefinitionConformanceReasons(tool, cryptoShared)).toEqual([]);

    const counterparty = tool.input_schema.properties.counterparty as {
      properties?: Record<string, unknown>;
    };
    delete counterparty.properties;
    expect(
      sharedDefinitionConformanceReasons(tool, cryptoShared).some((r) =>
        r.includes('property "counterparty" is missing the embedded property "country"'),
      ),
    ).toBe(true);
  });
});
