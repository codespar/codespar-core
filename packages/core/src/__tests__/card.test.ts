/**
 * codespar_card typed facade tests (enterprise CONTRATO-codespar-card §3-§6).
 *
 * Drives the real `createSession` facade with a mocked `fetch`: the wire
 * dispatch (`tool` + `input`) is asserted on the `/execute` call, and each
 * answer shape (issued, pending, card view, list, refusal in the envelope,
 * refusal as a non-2xx body, failure with no code) is asserted on the result.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { CardArgs, CardReadiness, CardView, IssueArgs, Session, ToolResult } from "@codespar/types";
import { createSession } from "../session.js";
import { CardContractMigrationError, resetIssueDeprecationWarning } from "../card.js";
import { CodeSpar } from "../index.js";
import { CodesparApiError } from "../errors.js";

interface ExecCall {
  tool: string;
  input: Record<string, unknown>;
}

type ExecAnswer =
  | { kind: "envelope"; envelope: Partial<ToolResult> }
  | { kind: "http"; status: number; body: string };

async function sessionAnswering(answer: ExecAnswer): Promise<{ session: Session; calls: ExecCall[] }> {
  const calls: ExecCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (typeof url === "string" && url.endsWith("/execute")) {
      calls.push(JSON.parse(init?.body ?? "{}") as ExecCall);
      if (answer.kind === "http") {
        return { ok: false, status: answer.status, text: async () => answer.body, json: async () => JSON.parse(answer.body) };
      }
      const env = { success: true, data: null, error: null, duration: 1, server: "_codespar", tool: "codespar_card", ...answer.envelope };
      return { ok: true, status: 200, text: async () => "", json: async () => env };
    }
    return {
      ok: true,
      status: 201,
      text: async () => "",
      json: async () => ({
        id: "ses_card",
        org_id: "org_test",
        user_id: "consumer_123",
        servers: [],
        status: "active",
        created_at: new Date().toISOString(),
        closed_at: null,
      }),
    };
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const session = await createSession(
    "consumer_123",
    { servers: [] },
    { baseUrl: "https://api.example.com", apiKey: "csk_live_test", timeout: 60000 },
  );
  return { session, calls };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const RAIN_VIEW: CardView = {
  id: "rcrd_abc",
  issuer: "rain",
  program: "rain_usd",
  currency: "USD",
  status: "not_activated",
  issuer_status: "notActivated",
  last4: "1234",
  network: null,
  mandate_id: "mnd_usd",
  consumer_id: "cons_1",
  created_at: "2026-11-18T12:00:00.000Z",
  available_actions: [],
  funding: { asset: "USDC" },
};

function issued(card: CardView) {
  return {
    state: "issued",
    issue_request_id: "cir_1",
    issuer: card.issuer,
    program: card.program,
    selection: { provider_requested: null, chosen_by: "currency" },
    card,
    authorization_id: "caia_1",
    authorization_active: true,
  };
}

const ISSUE_USD: CardArgs = {
  action: "issue",
  currency: "USD",
  mandate_id: "mnd_usd",
  consumer_id: "cons_1",
  idempotency_key: "idem_1",
};

describe("session.card facade", () => {
  it("dispatches execute('codespar_card', args) verbatim", async () => {
    const { session, calls } = await sessionAnswering({
      kind: "envelope",
      envelope: { data: issued(RAIN_VIEW) },
    });
    await session.card(ISSUE_USD);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe("codespar_card");
    expect(calls[0]!.input).toEqual(ISSUE_USD);
  });

  it("issue: an issued card comes back with state=issued, selection, the authorization and the nested card view", async () => {
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: { data: issued(RAIN_VIEW) },
    });
    const r = await session.card(ISSUE_USD);
    expect(r.state).toBe("issued");
    if (r.state !== "issued") throw new Error("unreachable");
    expect(r.issuer).toBe("rain");
    expect(r.program).toBe("rain_usd");
    expect(r.issue_request_id).toBe("cir_1");
    expect(r.card.currency).toBe("USD");
    expect(r.card.funding).toEqual({ asset: "USDC" });
    expect(r.card.network).toBeNull();
    expect(r.selection).toEqual({ provider_requested: null, chosen_by: "currency" });
    expect(r.card.available_actions).toEqual([]);
    expect(r.authorization_active).toBe(true);
  });

  it("issue: a pending_human answer is returned as-is with its pending_action", async () => {
    const pending = {
      state: "pending_human",
      issue_request_id: "cir_2",
      issuer: "pomelo",
      program: "pomelo_brl",
      pending_action: { id: "pa_1", kind: "authorize_automated_issuance", actor: "company_signatory", url: "https://codespar.dev/dashboard/x" },
    };
    const { session } = await sessionAnswering({ kind: "envelope", envelope: { data: pending } });
    const r = await session.card({ ...ISSUE_USD, currency: "BRL", provider: "pomelo" });
    expect(r).toEqual(pending);
    if (r.state !== "pending_human") throw new Error("unreachable");
    expect(r.pending_action.kind).toBe("authorize_automated_issuance");
  });

  it("issue without idempotency_key is refused before anything is sent", async () => {
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: RAIN_VIEW } });
    await expect(
      session.card({ ...ISSUE_USD, idempotency_key: "" }),
    ).rejects.toThrow(/idempotency_key is required/);
    expect(calls).toHaveLength(0);
  });

  it("get / freeze: the card view comes back untouched, no state stamped", async () => {
    const view: CardView = { ...RAIN_VIEW, id: "icrd_1", issuer: "pomelo", program: "pomelo_brl", currency: "BRL", status: "blocked", issuer_status: "BLOCKED", available_actions: ["unfreeze", "cancel"] };
    delete (view as { funding?: unknown }).funding;
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: view } });
    const r = await session.card({ action: "freeze", card_id: "icrd_1", reason: "lost" });
    expect(r).toEqual(view);
    expect(r.state).toBeUndefined();
    expect(calls[0]!.input).toEqual({ action: "freeze", card_id: "icrd_1", reason: "lost" });
  });

  it("list: { cards } comes back as-is", async () => {
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: { cards: [RAIN_VIEW] } } });
    const r = await session.card({ action: "list", issuer: "rain" });
    expect("cards" in r && r.cards).toEqual([RAIN_VIEW]);
    expect(calls[0]!.input).toEqual({ action: "list", issuer: "rain" });
  });

  it("a strategy refusal in the envelope is RETURNED as CardRefusal, details lifted", async () => {
    const programs = [
      { program: "pomelo_brl", issuer: "pomelo", currency: "BRL", available: true, operations: ["issue", "get", "list", "freeze", "unfreeze", "cancel"] },
      { program: "rain_usd", issuer: "rain", currency: "USD", available: false, reason: "live_blocked", operations: ["issue", "get", "list"] },
    ];
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: {
        success: false,
        error: "Rain is not available for this project",
        data: {
          error: "Rain is not available for this project",
          code: "card_issuer_unavailable",
          details: { reason: "live_blocked", available_programs: programs },
        },
      },
    });
    const r = await session.card(ISSUE_USD);
    expect(r.state).toBe("refused");
    if (r.state !== "refused") throw new Error("unreachable");
    expect(r.code).toBe("card_issuer_unavailable");
    expect(r.reason).toBe("live_blocked");
    expect(r.message).toBe("Rain is not available for this project");
    expect(r.available_programs).toEqual(programs);
    expect(r.http_status).toBe(200);
  });

  it("the enterprise tool-result refusal { error: { code, message, details }, http_status } is read as-is", async () => {
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: {
        success: false,
        error: "card_issuer_unavailable",
        data: {
          error: {
            code: "card_issuer_unavailable",
            message: "rain_usd is not available here",
            details: { reason: "live_blocked", available_programs: [{ program: "pomelo_brl", issuer: "pomelo", currency: "BRL" }] },
          },
          http_status: 422,
        },
      },
    });
    const r = await session.card(ISSUE_USD);
    if (r.state !== "refused") throw new Error("expected a refusal");
    expect(r).toMatchObject({
      code: "card_issuer_unavailable",
      message: "rain_usd is not available here",
      reason: "live_blocked",
      http_status: 422,
      available_programs: [{ program: "pomelo_brl", issuer: "pomelo", currency: "BRL" }],
    });
  });

  it("card_action_unsupported carries issuer, program, action and available_actions", async () => {
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: {
        success: false,
        error: "freeze is not supported on rain_usd",
        data: { error: "freeze is not supported on rain_usd", code: "card_action_unsupported", details: { issuer: "rain", program: "rain_usd", action: "freeze", available_actions: [] } },
      },
    });
    const r = await session.card({ action: "freeze", card_id: "rcrd_abc" });
    if (r.state !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    expect(r).toMatchObject({ code: "card_action_unsupported", issuer: "rain", program: "rain_usd", action: "freeze", available_actions: [] });
  });

  it("a non-2xx answer with a coded JSON body (scope refusal, 409 conflict) is a CardRefusal too", async () => {
    const { session } = await sessionAnswering({
      kind: "http",
      status: 409,
      body: JSON.stringify({ error: "idempotency_key_conflict", message: "same key, different body" }),
    });
    const r = await session.card(ISSUE_USD);
    if (r.state !== "refused") throw new Error("expected a refusal");
    expect(r.code).toBe("idempotency_key_conflict");
    expect(r.message).toBe("same key, different body");
    expect(r.http_status).toBe(409);
  });

  it("a failure with no stable code still throws (tool not registered)", async () => {
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: { success: false, data: null, error: "Tool not registered: codespar_card" },
    });
    await expect(session.card({ action: "get", card_id: "icrd_1" })).rejects.toThrow(
      /card failed: Tool not registered: codespar_card/,
    );
  });

  it.each(["processing", "uncertain", "failed"] as const)(
    "issue: a %s answer is returned as received, never stamped issued (contract §8.3)",
    async (state) => {
      const data = { state, issue_request_id: "cir_3", issuer: "rain", program: "rain_usd" };
      const { session } = await sessionAnswering({ kind: "envelope", envelope: { data } });
      const r = await session.card(ISSUE_USD);
      expect(r).toEqual(data);
      expect(r.state).toBe(state);
    },
  );

  it("an issue answer in an unknown state throws instead of passing as issued", async () => {
    for (const data of [{ state: "pending" }, RAIN_VIEW]) {
      const { session } = await sessionAnswering({ kind: "envelope", envelope: { data } });
      await expect(session.card(ISSUE_USD)).rejects.toThrow(/unexpected issue state/);
    }
  });

  it("card_oauth_not_bound comes back as a refusal like any coded one", async () => {
    const { session } = await sessionAnswering({
      kind: "envelope",
      envelope: { success: false, error: "token not bound", data: { error: "token not bound", code: "card_oauth_not_bound" } },
    });
    const r = await session.card(ISSUE_USD);
    expect(r).toMatchObject({ state: "refused", code: "card_oauth_not_bound" });
  });
});

describe("session.issue (deprecated, contract §8.4)", () => {
  it("warns once and sends codespar_card with the same args", async () => {
    resetIssueDeprecationWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, calls } = await sessionAnswering({
      kind: "envelope",
      envelope: { data: issued(RAIN_VIEW) },
    });
    const r = await session.issue(ISSUE_USD);
    await session.issue(ISSUE_USD);
    expect(r.state).toBe("issued");
    expect(calls.map((c) => c.tool)).toEqual(["codespar_card", "codespar_card"]);
    expect(calls[0]!.input).toEqual(ISSUE_USD);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/session\.issue\(\) is deprecated; use session\.card\(\)/);
    warn.mockRestore();
  });

  it("keeps the same validations: no idempotency_key, nothing sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: RAIN_VIEW } });
    await expect(session.issue({ ...ISSUE_USD, idempotency_key: "" })).rejects.toThrow(/idempotency_key is required/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ action: "card-virtual", cardholder_id: "usr_1", program_id: "afg_1" }, /action "card-virtual", "cardholder_id", "program_id"/],
    [{ action: "card-get", card_id: "icrd_1" }, /card\(\{ action: "get", card_id \}\)/],
    [{ action: "card-control", card_id: "icrd_1", control: "freeze" }, /"freeze" \| "unfreeze" \| "cancel"/],
  ] as const)("an old Pomelo-shaped call is refused before anything is sent: %j", async (args, message) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: RAIN_VIEW } });
    const err = await session.issue(args as unknown as IssueArgs).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CardContractMigrationError);
    expect((err as CardContractMigrationError).code).toBe("card_contract_migration_required");
    expect((err as Error).message).toMatch(message);
    expect((err as Error).message).toMatch(/currency \(BRL \| USD\), mandate_id, consumer_id and idempotency_key/);
    expect(calls).toHaveLength(0);
  });

  it("card() refuses old Pomelo fields too: no path keeps the old shape", async () => {
    const { session, calls } = await sessionAnswering({ kind: "envelope", envelope: { data: RAIN_VIEW } });
    await expect(
      session.card({ ...ISSUE_USD, cardholder_id: "usr_1" } as unknown as CardArgs),
    ).rejects.toBeInstanceOf(CardContractMigrationError);
    expect(calls).toHaveLength(0);
  });
});

describe("cs.cards.readiness", () => {
  it("GETs /v1/cards/readiness with the client's credentials and returns the checklist", async () => {
    const body: CardReadiness = {
      programs: [
        {
          program: "rain_usd",
          issuer: "rain",
          currency: "USD",
          ready: false,
          requirements: [
            { kind: "integration_connected", status: "done", actor: "org_admin" },
            { kind: "accept_terms", status: "pending", actor: "holder", action_url: "https://codespar.dev/x", pending_action_id: "pa_9" },
            { kind: "environment", status: "blocked", actor: "org_admin", reason: "live_blocked" },
          ],
        },
      ],
    };
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_test_x", baseUrl: "https://api.example.com", projectId: "prj_AAAAAAAAAAAAAAAA" });
    await expect(cs.cards.readiness()).resolves.toEqual(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.example.com/v1/cards/readiness");
    expect(seen[0]!.init?.method).toBe("GET");
    const h = seen[0]!.init?.headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer csk_test_x");
    expect(h["x-codespar-project"]).toBe("prj_AAAAAAAAAAAAAAAA");
  });

  it("a non-2xx answer throws CodesparApiError with the API's code", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "forbidden", message: "no" }), { status: 403, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    const cs = new CodeSpar({ apiKey: "csk_test_x", baseUrl: "https://api.example.com" });
    const err = await cs.cards.readiness().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect((err as CodesparApiError).status).toBe(403);
  });
});
