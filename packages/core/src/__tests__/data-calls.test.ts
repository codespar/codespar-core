/**
 * Shop G3.1 data calls (`cs.dataCalls`): the wire it sends to
 * `/v1/shop/agent/data-calls`, what it returns (the API's wire, four states
 * apart), that a key's `execute` surfaces `person_required` as an error and
 * never as a run, and the one-word outcome a program branches on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CodeSpar } from "../index.js";
import { CodesparApiError } from "../errors.js";
import { DataCallNeedsPersonError, dataCallOutcome, type DataCall } from "../data-calls.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const VIEW: DataCall = {
  proposal_id: "prp_AbCdEfGhIjKlMnOp",
  run_state: "ready",
  awaiting: null,
  offer: {
    offer_id: "sof_AbCdEfGhIjKlMnOp",
    offer_kind: "data_service",
    merchant_name: "Dados de teste CodeSpar",
    title: "Consulta de CNPJ (sintética)",
    attributes: { coverage: "BR", refresh: "daily", license: "internal_use", unit: "call", params: { cnpj: "11222333000181" }, offer_version: 1, terms_hash: "a".repeat(64) },
    cost_lines: [{ kind: "call", label: "Consulta", unit_minor: 50, quantity: 1, amount_minor: 50 }],
    total_minor: 50,
    currency: "BRL",
    observed_at: "2026-11-08T12:00:00.000Z",
    valid_until: "2026-11-08T12:15:00.000Z",
    source: { kind: "data_catalog" },
  },
  quotation: { state: "valid", total_minor: 50, observed_at: "2026-11-08T12:00:00.000Z", valid_until: "2026-11-08T12:15:00.000Z" },
  authorization: { state: "needed", amount_max_minor: 50 },
  commitment: { state: "not_started" },
  payment: { state: "none" },
  confirmation: { state: "none" },
  actions: { execute: true, cancel: true, requote: false },
};

function client(answer: (url: string, init: RequestInit) => { status: number; body: unknown }, seen: { url: string; method: string; body: unknown; auth: string | null }[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    seen.push({ url, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.get("authorization") });
    const a = answer(url, init);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return new CodeSpar({ apiKey: "csk_test_example", baseUrl: "https://api.example.com" });
}

describe("cs.dataCalls", () => {
  it("create sends the snake_case body and returns the wire; get unwraps data_call", async () => {
    const seen: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const NEXT = { kind: "person_authorization", url: `https://codespar.dev/dashboard/shop/data-calls/${VIEW.proposal_id}`, proposal_id: VIEW.proposal_id, description: "x" };
    const cs = client(
      (url) => (url.endsWith("/data-calls") ? { status: 201, body: { data_call: VIEW, next_action: NEXT, idempotent_replay: false } } : { status: 200, body: { data_call: VIEW, next_action: NEXT } }),
      seen,
    );
    const created = await cs.dataCalls.create({ agentId: "ag_example", offerId: VIEW.offer.offer_id, idempotencyKey: "idem_example_1" });
    expect(created).toEqual({ data_call: VIEW, next_action: NEXT, idempotent_replay: false });
    expect(seen[0]).toMatchObject({
      url: "https://api.example.com/v1/shop/agent/data-calls",
      method: "POST",
      body: { agent_id: "ag_example", offer_id: VIEW.offer.offer_id, idempotency_key: "idem_example_1" },
      auth: "Bearer csk_test_example",
    });
    const read = await cs.dataCalls.get(VIEW.proposal_id);
    expect(read).toEqual({ data_call: VIEW, next_action: NEXT });
    expect(seen[1]).toMatchObject({ url: `https://api.example.com/v1/shop/agent/data-calls/${VIEW.proposal_id}`, method: "GET" });
  });

  it("a key's execute surfaces person_required with the protected action, never as a run", async () => {
    const seen: { url: string; method: string; body: unknown; auth: string | null }[] = [];
    const url = `https://codespar.dev/dashboard/shop/data-calls/${VIEW.proposal_id}`;
    const cs = client(
      () => ({
        status: 403,
        body: { error: { code: "person_required", message: "running a data call is the person's authorization", details: { next_action: { kind: "person_authorization", url, proposal_id: VIEW.proposal_id, description: "x" }, data_call: VIEW } } },
      }),
      seen,
    );
    const err = await cs.dataCalls.execute(VIEW.proposal_id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataCallNeedsPersonError);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect((err as DataCallNeedsPersonError).nextAction?.url).toBe(url);
    expect((err as CodesparApiError).status).toBe(403);
    expect((err as CodesparApiError).code).toBe("person_required");
    expect(seen[0]).toMatchObject({ url: `https://api.example.com/v1/shop/agent/data-calls/${VIEW.proposal_id}/execute`, method: "POST" });
  });

  it("a refused draft (the offer is not a data service) is an error with the API's code", async () => {
    const cs = client(() => ({ status: 422, body: { error: { code: "offer_not_data_service", message: "this offer is not a data service" } } }), []);
    const err = await cs.dataCalls.create({ agentId: "ag_example", offerId: "sof_x", idempotencyKey: "idem_example_2" }).catch((e: unknown) => e);
    expect((err as CodesparApiError).code).toBe("offer_not_data_service");
  });
});

describe("dataCallOutcome: one word from the four states", () => {
  const at = (over: Partial<DataCall>): DataCall => ({ ...VIEW, ...over });
  it("confirmed is succeeded; uncertain is uncertain, whatever the payment says", () => {
    expect(dataCallOutcome(at({ confirmation: { state: "confirmed", result_ref: "tdr_1" }, commitment: { state: "settled" }, payment: { state: "held", held_minor: 50 } }))).toBe("succeeded");
    expect(dataCallOutcome(at({ commitment: { state: "uncertain" }, payment: { state: "debited", debited_minor: 50 } }))).toBe("uncertain");
  });
  it("terms changed or cancelled is refused; a call that failed after the send is failed; a draft is pending", () => {
    expect(dataCallOutcome(at({ error: { code: "commitment_terms_changed" } }))).toBe("refused");
    expect(dataCallOutcome(at({ run_state: "cancelled", commitment: { state: "cancelled" } }))).toBe("refused");
    expect(dataCallOutcome(at({ commitment: { state: "failed" }, confirmation: { state: "failed" } }))).toBe("failed");
    expect(dataCallOutcome(VIEW)).toBe("pending");
  });
});
