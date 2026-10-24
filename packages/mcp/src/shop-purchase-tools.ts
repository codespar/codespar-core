/**
 * Shop v0.2 delegated purchases as MCP tools: the same three operations as
 * `session.purchases` / `session.instruments` (`/v1/shop/agent/*`), with the
 * JSON Schemas an MCP client shows the model.
 *
 * What they cannot do is the point: propose and read only. Paying, saving a
 * card and logging in at a store stay the verified person's acts on the
 * CodeSpar dashboard; no tool here takes or returns a card number, a code, a
 * password or a cookie. Each call needs its delegated scope on the key
 * (`shop:purchases:write`, `shop:purchases:read`, `shop:instruments:read`).
 */
import type { Session } from "@codespar/sdk";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SHOP_PURCHASE_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "codespar_shop_purchase_propose",
    description:
      "Propose a purchase at a supported store (never an order). A person presses Pagar on the CodeSpar dashboard; " +
      "if a card, a security code or a store login is needed, the purchase waits for them there. Needs shop:purchases:write.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "merchant", "items", "idempotency_key"],
      properties: {
        agent_id: { type: "string", description: "The registered agent proposing it." },
        merchant: { type: "string", description: "The store id from the Shop registry (e.g. test-merchant)." },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["sku_id", "quantity"],
            properties: { sku_id: { type: "string" }, quantity: { type: "integer", minimum: 1, maximum: 99 } },
          },
        },
        payment_method: { type: "string", enum: ["card", "store_on_file"] },
        idempotency_key: { type: "string", description: "The same key with the same intent answers the same purchase." },
      },
    },
  },
  {
    name: "codespar_shop_purchase_status",
    description: "Where a proposed purchase stands: state, what it waits for, the store's order and an external receipt. Needs shop:purchases:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["purchase_id"],
      properties: { purchase_id: { type: "string", pattern: "^prp_[A-Za-z0-9_-]{16}$" } },
    },
  },
  {
    name: "codespar_shop_instruments",
    description: "A person's cards as masked references (brand and last four). Choosing one stays the person's act at Pagar. Needs shop:instruments:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["owner"],
      properties: { owner: { type: "string", description: "The person whose masked cards may be referenced." } },
    },
  },
];

export function isShopPurchaseTool(name: string): boolean {
  return SHOP_PURCHASE_MCP_TOOLS.some((t) => t.name === name);
}

/** Run one of the tools through the session's facade. Throws on a refusal (a missing scope included). */
export async function callShopPurchaseTool(session: Session, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!session.purchases || !session.instruments) throw new Error("this runtime does not offer Shop delegated purchases");
  switch (name) {
    case "codespar_shop_purchase_propose": {
      const items = Array.isArray(args.items) ? (args.items as Array<{ sku_id: string; quantity: number }>) : [];
      return session.purchases.create({
        agentId: String(args.agent_id ?? ""),
        merchant: String(args.merchant ?? ""),
        items: items.map((i) => ({ skuId: String(i.sku_id), quantity: Number(i.quantity) })),
        ...(args.payment_method === "store_on_file" || args.payment_method === "card" ? { paymentMethod: args.payment_method } : {}),
        idempotencyKey: String(args.idempotency_key ?? ""),
      });
    }
    case "codespar_shop_purchase_status":
      return session.purchases.get(String(args.purchase_id ?? ""));
    case "codespar_shop_instruments":
      return session.instruments.list({ owner: String(args.owner ?? "") });
    default:
      throw new Error(`unknown Shop purchase tool ${name}`);
  }
}
