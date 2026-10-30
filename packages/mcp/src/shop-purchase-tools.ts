/**
 * Shop v0.2 delegated purchases as MCP tools: the same operations as
 * `session.purchases` / `session.instruments` (`/v1/shop/agent/*`), with the
 * JSON Schemas an MCP client shows the model. Shop v0.3 adds the research
 * (`session.research`, `/v1/shop/agent/research`) and a purchase proposed from
 * one of its offers.
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
      "if a card, a security code or a store login is needed, the purchase waits for them there. Name the store and the " +
      "items, or an offer_id from codespar_shop_research: then the store quotes it again, and a moved price or shipping " +
      "is offer_stale with nothing proposed. Needs shop:purchases:write.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "idempotency_key"],
      properties: {
        agent_id: { type: "string", description: "The registered agent proposing it." },
        offer_id: { type: "string", pattern: "^sof_[A-Za-z0-9_-]{16}$", description: "An offer of codespar_shop_research; without merchant and items." },
        quantity: { type: "integer", minimum: 1, maximum: 99, description: "With offer_id: how many units (default 1)." },
        merchant: { type: "string", description: "The store id from the Shop registry (e.g. test-merchant), with items." },
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
    name: "codespar_shop_research",
    description:
      "Research a pedido aberto across the stores the Shop consults: every offer with its source and observed_at, price, " +
      "shipping, total, delivery days, stock, seller and warranty when the store shows them; one principal recommendation " +
      "with reason codes and at most three alternatives; the lowest total stated as \"menor preço entre as ofertas consultadas\" " +
      "with its count and time; and decisive_unknowns, the only questions worth asking the person. Offers from stores " +
      "outside the purchase registry are comparison only. Proposes nothing. Needs shop:purchases:write.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 200, description: "The pedido aberto, e.g. \"fone bluetooth\"." },
        priority: { type: "string", enum: ["total", "eta"], description: "What decides the principal: the lowest total (default) or the fastest delivery." },
        max_total_minor: { type: "integer", minimum: 1, description: "The most to pay, shipping included, in centavos." },
        sources: { type: "array", items: { type: "string", enum: ["registry", "vtex", "meli"] }, description: "Where to look; default: registry in Test, vtex and meli in Live." },
        limit: { type: "integer", minimum: 1, maximum: 5, description: "Offers per source (default 5)." },
      },
    },
  },
  {
    name: "codespar_shop_research_status",
    description: "Read a research back, with each offer's staleness at the time of the answer. Needs shop:purchases:read.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["research_id"],
      properties: { research_id: { type: "string", pattern: "^srr_[A-Za-z0-9_-]{16}$" } },
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
      const paymentMethod: "card" | "store_on_file" | undefined =
        args.payment_method === "store_on_file" || args.payment_method === "card" ? args.payment_method : undefined;
      const common = {
        agentId: String(args.agent_id ?? ""),
        ...(paymentMethod ? { paymentMethod } : {}),
        idempotencyKey: String(args.idempotency_key ?? ""),
      };
      if (typeof args.offer_id === "string") {
        return session.purchases.create({ ...common, offerId: args.offer_id, ...(typeof args.quantity === "number" ? { quantity: args.quantity } : {}) });
      }
      const items = Array.isArray(args.items) ? (args.items as Array<{ sku_id: string; quantity: number }>) : [];
      return session.purchases.create({
        ...common,
        merchant: String(args.merchant ?? ""),
        items: items.map((i) => ({ skuId: String(i.sku_id), quantity: Number(i.quantity) })),
      });
    }
    case "codespar_shop_research": {
      if (!session.research) throw new Error("this runtime does not offer Shop research");
      const sources = Array.isArray(args.sources) ? (args.sources as ("registry" | "vtex" | "meli")[]) : undefined;
      const priority: "total" | "eta" | undefined = args.priority === "total" || args.priority === "eta" ? args.priority : undefined;
      const criteria = {
        ...(priority ? { priority } : {}),
        ...(typeof args.max_total_minor === "number" ? { maxTotalMinor: args.max_total_minor } : {}),
        ...(sources ? { sources } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      };
      return session.research.create({ query: String(args.query ?? ""), ...(Object.keys(criteria).length > 0 ? { criteria } : {}) });
    }
    case "codespar_shop_research_status":
      if (!session.research) throw new Error("this runtime does not offer Shop research");
      return session.research.get(String(args.research_id ?? ""));
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
