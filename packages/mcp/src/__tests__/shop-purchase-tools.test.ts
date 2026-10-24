/**
 * Shop v0.2 delegated purchases over MCP: the three tool schemas are closed
 * (no free fields, no card data), and a call goes through the session's
 * facade; a refusal (a missing scope) is an error, never a success.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@codespar/sdk";
import { SHOP_PURCHASE_MCP_TOOLS, callShopPurchaseTool, isShopPurchaseTool } from "../shop-purchase-tools.js";

describe("Shop purchase MCP tools", () => {
  it("are closed schemas with no card, code, password or cookie field", () => {
    expect(SHOP_PURCHASE_MCP_TOOLS.map((t) => t.name)).toEqual(["codespar_shop_purchase_propose", "codespar_shop_purchase_status", "codespar_shop_instruments"]);
    const text = JSON.stringify(SHOP_PURCHASE_MCP_TOOLS.map((t) => t.inputSchema));
    for (const forbidden of ["pan", "card_number", "cvv", "cvc", "password", "cookie"]) expect(text.toLowerCase().includes(`"${forbidden}"`)).toBe(false);
    for (const t of SHOP_PURCHASE_MCP_TOOLS) expect(t.inputSchema.additionalProperties).toBe(false);
    expect(isShopPurchaseTool("codespar_pay")).toBe(false);
  });

  it("route calls to the session facade, and a refusal throws", async () => {
    const calls: unknown[] = [];
    const session = {
      purchases: {
        create: async (i: unknown) => (calls.push(["create", i]), { purchase: { id: "prp_AbCdEfGhIjKlMnOp" } }),
        get: async (id: string) => (calls.push(["get", id]), { id }),
      },
      instruments: {
        list: async (o: unknown) => {
          calls.push(["list", o]);
          throw new Error("403: forbidden");
        },
      },
    } as unknown as Session;
    await callShopPurchaseTool(session, "codespar_shop_purchase_propose", { agent_id: "ag", merchant: "test-merchant", items: [{ sku_id: "x", quantity: 2 }], idempotency_key: "idem_0001" });
    expect(calls[0]).toEqual(["create", { agentId: "ag", merchant: "test-merchant", items: [{ skuId: "x", quantity: 2 }], idempotencyKey: "idem_0001" }]);
    await callShopPurchaseTool(session, "codespar_shop_purchase_status", { purchase_id: "prp_AbCdEfGhIjKlMnOp" });
    await expect(callShopPurchaseTool(session, "codespar_shop_instruments", { owner: "u" })).rejects.toThrow(/forbidden/);
  });
});
