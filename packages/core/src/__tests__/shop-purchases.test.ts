/**
 * Shop v0.2 delegated purchases facade (`session.purchases`, `session.instruments`):
 * the wire it sends to `/v1/shop/agent/*`, what it returns, and that a refusal
 * (a key without the delegated scope answers 403 `forbidden`) surfaces as an
 * error, never as an empty success.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodesparApiError } from "../errors.js";
import { createSession } from "../session.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Seen {
  url: string;
  method: string;
  body: unknown;
  auth: string | undefined;
}

const PURCHASE = {
  id: "prp_AbCdEfGhIjKlMnOp",
  kind: "purchase",
  state: "drafted",
  run_state: "ready",
  awaiting: null,
  merchant: { id: "test-merchant", name: "Loja de teste CodeSpar" },
  items: [{ sku_id: "cafe-especial-250g", name: "Café", quantity: 1, unit_price_minor: 4590 }],
  total_minor: 4590,
  currency: "BRL",
  payment_method: "card",
  order: null,
  receipt: null,
  failure: null,
  next_action: "a person presses Pagar on the dashboard",
};

async function sessionWith(answer: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
    const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/v1/sessions")) {
      return json(201, { id: "ses_k1", org_id: "org_t", user_id: "u", servers: [], status: "active", created_at: new Date().toISOString(), closed_at: null });
    }
    const s: Seen = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null, auth: init?.headers?.Authorization };
    seen.push(s);
    const a = answer(s);
    return json(a.status, a.body);
  }) as unknown as typeof fetch;
  const session = await createSession("u", { servers: [] }, { baseUrl: "https://api.example.com", apiKey: "csk_test_k1", timeout: 10_000 });
  return { session, seen };
}

describe("session.purchases", () => {
  it("create proposes with the wire's snake_case and returns the purchase, never an order", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 201, body: { purchase: PURCHASE, proposal: null, idempotent_replay: false } }));
    const made = await session.purchases!.create({ agentId: "ag_1", merchant: "test-merchant", items: [{ skuId: "cafe-especial-250g", quantity: 1 }], idempotencyKey: "idem_k1_0001" });
    expect(seen[0]).toMatchObject({
      url: "https://api.example.com/v1/shop/agent/purchases",
      method: "POST",
      body: { agent_id: "ag_1", merchant: "test-merchant", items: [{ sku_id: "cafe-especial-250g", quantity: 1 }], payment_method: "card", idempotency_key: "idem_k1_0001" },
      auth: "Bearer csk_test_k1",
    });
    expect(made.purchase).toMatchObject({ id: PURCHASE.id, state: "drafted", order: null });
  });

  it("get reads where the purchase stands", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 200, body: { purchase: { ...PURCHASE, state: "succeeded", run_state: "completed", receipt: { funding_origin: "external_card", wallet_debit: false } } } }));
    const p = await session.purchases!.get(PURCHASE.id);
    expect(seen[0]!.url).toBe(`https://api.example.com/v1/shop/agent/purchases/${PURCHASE.id}`);
    expect(p.receipt).toEqual({ funding_origin: "external_card", wallet_debit: false });
  });

  it("a key without the delegated scope gets an error, not an empty success", async () => {
    const { session } = await sessionWith(() => ({ status: 403, body: { error: "forbidden", message: "missing scope shop:purchases:write", status: 403 } }));
    await expect(session.purchases!.create({ agentId: "ag_1", merchant: "test-merchant", items: [{ skuId: "x", quantity: 1 }], idempotencyKey: "idem_k1_0002" })).rejects.toBeInstanceOf(CodesparApiError);
  });
});

describe("session.instruments", () => {
  it("lists a person's cards masked", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 200, body: { instruments: [{ id: "cfs_AAAAAAAA", kind: "byo_card", brand: "visa", last4: "4242", status: "active" }] } }));
    const list = await session.instruments!.list({ owner: "user_ana" });
    expect(seen[0]!.url).toBe("https://api.example.com/v1/shop/agent/instruments?owner=user_ana");
    expect(list).toEqual([{ id: "cfs_AAAAAAAA", kind: "byo_card", brand: "visa", last4: "4242", status: "active" }]);
  });
});
