/**
 * Shop v0.2 delegated purchases facade (`session.purchases`, `session.instruments`):
 * the wire it sends to `/v1/shop/agent/*`, what it returns, and that a refusal
 * (a key without the delegated scope answers 403 `forbidden`) surfaces as an
 * error, never as an empty success.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BearerTokenHasNoPersonError, CodesparApiError } from "../errors.js";
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
  it("lists the authenticated person's cards masked, with no owner to name", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 200, body: { instruments: [{ id: "cfs_AAAAAAAA", kind: "byo_card", brand: "visa", last4: "4242", status: "active" }] } }));
    const list = await session.instruments!.list();
    expect(seen[0]!.url).toBe("https://api.example.com/v1/shop/agent/instruments");
    expect(list).toEqual([{ id: "cfs_AAAAAAAA", kind: "byo_card", brand: "visa", last4: "4242", status: "active" }]);
  });

  it("still sends the deprecated owner when given, for an API older than Shop v0.3", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 200, body: { instruments: [] } }));
    await session.instruments!.list({ owner: "user_ana" });
    expect(seen[0]!.url).toBe("https://api.example.com/v1/shop/agent/instruments?owner=user_ana");
  });

  it("a credential with no person gets the typed error with the API's details, never an empty list", async () => {
    const details = { reason: "bearer_has_no_person", list_belongs_to: "authenticated_person", owner_param: "deprecated_ignored", how_to_list: "the person's own session on the dashboard" };
    const { session } = await sessionWith(() => ({ status: 403, body: { error: { code: "bearer_token_has_no_person", message: "this list is a person's own", details }, request_id: null } }));
    const err = await session.instruments!.list({ owner: "user_ana" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BearerTokenHasNoPersonError);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err).toMatchObject({ status: 403, code: "bearer_token_has_no_person", details });
    expect(String((err as Error).message)).toMatch(/carries no person/);
  });

  it("CONTROL: another 403 (a missing scope) stays the generic error", async () => {
    const { session } = await sessionWith(() => ({ status: 403, body: { error: "forbidden", message: "missing scope shop:instruments:read", status: 403 } }));
    const err = await session.instruments!.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err).not.toBeInstanceOf(BearerTokenHasNoPersonError);
  });
});

describe("Shop v0.3: session.research and a purchase from an offer", () => {
  const RESEARCH = { id: "srr_AbCdEfGhIjKlMnOp", state: "completed", offers: [], recommendation: { principal_offer_id: null } };

  it("research.create sends the query and the criteria in the wire's snake_case, and returns the research", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 201, body: { research: RESEARCH } }));
    const r = await session.research!.create({ query: "fone bluetooth", criteria: { priority: "eta", maxTotalMinor: 40000, sources: ["registry"], limit: 3 } });
    expect(seen[0]).toMatchObject({
      url: "https://api.example.com/v1/shop/agent/research",
      method: "POST",
      body: { query: "fone bluetooth", criteria: { priority: "eta", max_total_minor: 40000, sources: ["registry"], limit: 3 } },
    });
    expect(r.id).toBe(RESEARCH.id);
  });

  it("research.create without criteria sends only the query; research.get reads it back by id", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 200, body: { research: RESEARCH } }));
    await session.research!.create({ query: "fone" });
    expect(seen[0]!.body).toEqual({ query: "fone" });
    await session.research!.get(RESEARCH.id);
    expect(seen[1]).toMatchObject({ url: `https://api.example.com/v1/shop/agent/research/${RESEARCH.id}`, method: "GET" });
  });

  it("purchases.create with an offerId sends offer_id and quantity, never merchant or items", async () => {
    const { session, seen } = await sessionWith(() => ({ status: 201, body: { purchase: PURCHASE, proposal: null, idempotent_replay: false } }));
    await session.purchases!.create({ agentId: "ag_1", offerId: "sof_AbCdEfGhIjKlMnOp", quantity: 2, idempotencyKey: "idem_k1_0002" });
    expect(seen[0]!.body).toEqual({ agent_id: "ag_1", offer_id: "sof_AbCdEfGhIjKlMnOp", quantity: 2, payment_method: "card", idempotency_key: "idem_k1_0002" });
  });

  it("a refused research (offer moved, no source) surfaces as an error, never an empty success", async () => {
    const { session } = await sessionWith(() => ({ status: 409, body: { error: { code: "research_no_sources", message: "no source" } } }));
    await expect(session.research!.create({ query: "fone" })).rejects.toBeInstanceOf(CodesparApiError);
  });
});
