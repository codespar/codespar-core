import { describe, it, expect } from "vitest";
import type { IssueArgs, LedgerArgs } from "@codespar/sdk";
import { validateLedgerArgs } from "../commands/ledger.js";
import { validateIssueArgs } from "../commands/issue.js";
import { resolveMetaInput } from "../commands/meta-input.js";

describe("validateLedgerArgs", () => {
  it("rejects an unknown action", () => {
    expect(() => validateLedgerArgs({ action: "nope" } as unknown as LedgerArgs)).toThrow(
      /action must be one of/,
    );
  });

  it("requires asset + non-empty source + destination for an entry", () => {
    expect(() => validateLedgerArgs({ action: "entry" })).toThrow(/asset is required/);
    expect(() => validateLedgerArgs({ action: "entry", asset: "BRL" })).toThrow(/source/);
    expect(() =>
      validateLedgerArgs({ action: "entry", asset: "BRL", source: [{ account: "a", amount: 1 }] }),
    ).toThrow(/destination/);
  });

  it("requires an account id for a balance read", () => {
    expect(() => validateLedgerArgs({ action: "balance" })).toThrow(/account/);
  });

  it("accepts a well-formed entry", () => {
    expect(() =>
      validateLedgerArgs({
        action: "entry",
        asset: "BRL",
        source: [{ account: "@external/BRL", amount: 100 }],
        destination: [{ account: "@wallet/u", amount: 100 }],
      }),
    ).not.toThrow();
  });
});

describe("validateIssueArgs", () => {
  it("rejects an unknown action", () => {
    expect(() => validateIssueArgs({ action: "nope" } as unknown as IssueArgs)).toThrow(
      /action must be one of/,
    );
  });

  it("requires cardholder_id + program_id to issue a card", () => {
    expect(() => validateIssueArgs({ action: "card-virtual" })).toThrow(/cardholder_id/);
    expect(() => validateIssueArgs({ action: "card-virtual", cardholder_id: "u" })).toThrow(
      /program_id/,
    );
  });

  it("requires card_id for control + get", () => {
    expect(() => validateIssueArgs({ action: "card-get" })).toThrow(/card_id/);
  });

  it("requires a control verb for card-control", () => {
    expect(() => validateIssueArgs({ action: "card-control", card_id: "c" })).toThrow(/control/);
  });

  it("requires a shipping_address for a physical card", () => {
    expect(() =>
      validateIssueArgs({ action: "card-physical", cardholder_id: "u", program_id: "p" }),
    ).toThrow(/shipping_address/);
  });
});

describe("resolveMetaInput", () => {
  it("rejects passing both --input and --input-file", async () => {
    await expect(
      resolveMetaInput({ input: "{}", inputFile: "x.json" }, "ledger", "ex"),
    ).rejects.toThrow(/either/);
  });

  it("rejects passing neither", async () => {
    await expect(resolveMetaInput({}, "ledger", "ex")).rejects.toThrow(/requires --input/);
  });

  it("rejects invalid JSON", async () => {
    await expect(resolveMetaInput({ input: "{bad" }, "ledger", "ex")).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("rejects a non-object (array / scalar) body", async () => {
    await expect(resolveMetaInput({ input: "[]" }, "ledger", "ex")).rejects.toThrow(
      /must be a JSON object/,
    );
  });

  it("parses a valid JSON object", async () => {
    await expect(resolveMetaInput({ input: '{"action":"entry"}' }, "ledger", "ex")).resolves.toEqual(
      { action: "entry" },
    );
  });
});
