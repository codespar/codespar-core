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
    expect(SHOP_PURCHASE_MCP_TOOLS.map((t) => t.name)).toEqual([
      "codespar_shop_purchase_propose",
      "codespar_shop_research",
      "codespar_shop_research_status",
      "codespar_shop_purchase_status",
      "codespar_shop_instruments",
    ]);
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

  it("Shop v0.3: a research goes through session.research, and a purchase from an offer names only the offer", async () => {
    const calls: unknown[] = [];
    const session = {
      purchases: { create: async (i: unknown) => (calls.push(["create", i]), { purchase: { id: "prp_AbCdEfGhIjKlMnOp" } }), get: async () => ({}) },
      instruments: { list: async () => [] },
      research: {
        create: async (i: unknown) => (calls.push(["research", i]), { id: "srr_AbCdEfGhIjKlMnOp" }),
        get: async (id: string) => (calls.push(["research.get", id]), { id }),
      },
    } as unknown as Session;
    await callShopPurchaseTool(session, "codespar_shop_research", { query: "fone bluetooth", priority: "eta", max_total_minor: 40000, sources: ["registry"] });
    expect(calls[0]).toEqual(["research", { query: "fone bluetooth", criteria: { priority: "eta", maxTotalMinor: 40000, sources: ["registry"] } }]);
    await callShopPurchaseTool(session, "codespar_shop_research", { query: "fone" });
    expect(calls[1]).toEqual(["research", { query: "fone" }]);
    await callShopPurchaseTool(session, "codespar_shop_research_status", { research_id: "srr_AbCdEfGhIjKlMnOp" });
    expect(calls[2]).toEqual(["research.get", "srr_AbCdEfGhIjKlMnOp"]);
    await callShopPurchaseTool(session, "codespar_shop_purchase_propose", { agent_id: "ag", offer_id: "sof_AbCdEfGhIjKlMnOp", quantity: 2, idempotency_key: "idem_0002" });
    expect(calls[3]).toEqual(["create", { agentId: "ag", offerId: "sof_AbCdEfGhIjKlMnOp", quantity: 2, idempotencyKey: "idem_0002" }]);
  });
});
