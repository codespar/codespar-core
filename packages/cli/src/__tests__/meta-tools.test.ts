import { describe, it, expect } from "vitest";
import type { CardArgs, LedgerArgs } from "@codespar/sdk";
import { validateLedgerArgs } from "../commands/ledger.js";
import { buildCardArgs, validateCardArgs } from "../commands/card.js";
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

describe("validateCardArgs", () => {
  it("rejects an action codespar_card does not publish", () => {
    expect(() => validateCardArgs({ action: "nope" } as unknown as CardArgs)).toThrow(
      /action must be one of: issue, get, list, freeze, unfreeze, cancel/,
    );
  });

  it("issue needs currency, mandate, consumer and the idempotency key", () => {
    const full = { action: "issue", currency: "BRL", mandate_id: "m", consumer_id: "c", idempotency_key: "k" } as const;
    expect(() => validateCardArgs(full)).not.toThrow();
    expect(() => validateCardArgs({ ...full, currency: undefined } as unknown as CardArgs)).toThrow(/--currency/);
    expect(() => validateCardArgs({ ...full, mandate_id: "" })).toThrow(/--mandate-id/);
    expect(() => validateCardArgs({ ...full, consumer_id: "" })).toThrow(/--consumer-id/);
    expect(() => validateCardArgs({ ...full, idempotency_key: "" })).toThrow(/--idempotency-key/);
  });

  it("currency, provider and issuer only take the published vocabulary", () => {
    const full = { action: "issue", currency: "BRL", mandate_id: "m", consumer_id: "c", idempotency_key: "k" } as const;
    expect(() => validateCardArgs({ ...full, currency: "EUR" } as unknown as CardArgs)).toThrow(/currency must be one of: BRL, USD/);
    expect(() => validateCardArgs({ ...full, provider: "bridge" } as unknown as CardArgs)).toThrow(/provider must be one of: pomelo, rain/);
    expect(() => validateCardArgs({ action: "list", issuer: "stripe" } as unknown as CardArgs)).toThrow(/issuer must be one of/);
    expect(() => validateCardArgs({ ...full, currency: "USD", provider: "rain" })).not.toThrow();
  });

  it("get and the controls need a card id; list does not", () => {
    for (const action of ["get", "freeze", "unfreeze", "cancel"] as const) {
      expect(() => validateCardArgs({ action } as unknown as CardArgs)).toThrow(/needs a card id/);
    }
    expect(() => validateCardArgs({ action: "list" })).not.toThrow();
  });
});

describe("buildCardArgs", () => {
  it("maps the flags onto the wire names and upper-cases the currency", async () => {
    await expect(
      buildCardArgs("issue", undefined, { currency: "usd", mandateId: "mnd_1", consumerId: "cons_1", idempotencyKey: "idem_1" }),
    ).resolves.toEqual({ action: "issue", currency: "USD", mandate_id: "mnd_1", consumer_id: "cons_1", idempotency_key: "idem_1" });
  });

  it("flags win over --input JSON, and the positional card id over both", async () => {
    await expect(
      buildCardArgs("freeze", "icrd_pos", { input: '{"card_id":"icrd_json","reason":"broken"}', reason: "lost" }),
    ).resolves.toEqual({ action: "freeze", card_id: "icrd_pos", reason: "lost" });
  });

  it("--reason takes only the published vocabulary; --holder is parsed as a JSON object", async () => {
    await expect(buildCardArgs("cancel", "icrd_1", { reason: "because" })).rejects.toThrow(/reason must be one of: client_request, lost, stolen, broken, upgrade/);
    await expect(
      buildCardArgs("issue", undefined, { currency: "BRL", mandateId: "m", consumerId: "c", idempotencyKey: "k", holder: '{"full_name":"A B"}' }),
    ).resolves.toMatchObject({ holder: { full_name: "A B" } });
    await expect(
      buildCardArgs("issue", undefined, { currency: "BRL", mandateId: "m", consumerId: "c", idempotencyKey: "k", holder: "[1]" }),
    ).rejects.toThrow(/--holder must be a JSON object/);
  });

  it("refuses JSON that names another action", async () => {
    await expect(buildCardArgs("get", "icrd_1", { input: '{"action":"cancel"}' })).rejects.toThrow(
      /the JSON input says action=cancel/,
    );
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
