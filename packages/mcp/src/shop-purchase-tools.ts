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
 * Since Shop v0.3 the card list is the authenticated person's own: with a
 * project key it answers a text saying so (`INSTRUMENTS_NEED_A_PERSON`).
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
    description:
      "The authenticated person's cards as masked references (brand and last four). Choosing one stays the person's act at Pagar. " +
      "Needs a session bound to a person: with a project API key the API refuses the list (bearer_token_has_no_person), " +
      "and this tool says so instead of listing.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

/**
 * What `codespar_shop_instruments` answers when the session carries no person
 * (a project API key): the reason and the way forward, as text the model
 * relays, not a failure to retry.
 */
export const INSTRUMENTS_NEED_A_PERSON =
  "No cards listed: the card list belongs to the person who is signed in, and this session uses a project key, " +
  "which carries no person (bearer_token_has_no_person). The person sees their cards on the CodeSpar dashboard and " +
  "chooses one there when they press Pagar. A session bound to a person (consent by login) arrives with Shop v0.3 increment 5.";

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
      try {
        return await session.instruments.list();
      } catch (err) {
        // Shop v0.3: the list is the authenticated person's own. Read by code, not by class, so an
        // older @codespar/sdk inside the peer range is read the same way.
        if ((err as { code?: unknown } | null)?.code === "bearer_token_has_no_person") return INSTRUMENTS_NEED_A_PERSON;
        throw err;
      }
    default:
      throw new Error(`unknown Shop purchase tool ${name}`);
  }
}
