/**
 * `codespar card <action>` end to end over a mocked backend: what reaches
 * /execute, what a script reads in `--json`, and that a refusal ends the
 * command with the refusal's code and body (exit 1 via the top-level handler)
 * while a pending issue does not.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../api.js";
import { CliError } from "../config.js";
import { cardCommand, cardReadinessCommand, issueDeprecatedCommand } from "../commands/card.js";

const AUTH = { apiKey: "csk_test_notreal", baseUrl: "https://api.test.dev" };

const SESSION = {
  id: "sess_card",
  org_id: "org_0000",
  user_id: "cli-user",
  servers: [],
  status: "active",
  created_at: new Date().toISOString(),
  closed_at: null,
};

const POMELO_VIEW = {
  id: "icrd_1",
  issuer: "pomelo",
  program: "pomelo_brl",
  currency: "BRL",
  status: "active",
  issuer_status: "ACTIVE",
  last4: "4242",
  network: "MASTERCARD",
  mandate_id: "mnd_brl",
  consumer_id: "cons_1",
  created_at: "2026-11-18T12:00:00.000Z",
  available_actions: ["freeze", "cancel"],
};

function backend(envelope: Record<string, unknown>): { sent: Array<{ tool: string; input: Record<string, unknown> }> } {
  const sent: Array<{ tool: string; input: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input: unknown, init: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    const ok = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    if (url.endsWith("/v1/sessions") && method === "POST") return ok(SESSION);
    if (url.endsWith(`/v1/sessions/${SESSION.id}/execute`)) {
      sent.push(JSON.parse(String((init as RequestInit).body)) as { tool: string; input: Record<string, unknown> });
      return ok({ duration: 1, server: "_codespar", tool: "codespar_card", ...envelope });
    }
    if (url.endsWith(`/v1/sessions/${SESSION.id}`) && method === "DELETE") return ok({ ok: true });
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  return { sent };
}

function captureStdout(): { text: () => string; err: () => string } {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  return { text: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

describe("codespar card", () => {
  it("issue sends codespar_card with the wire names and prints the issued card in --json", async () => {
    const { sent } = backend({
      success: true,
      error: null,
      data: {
        state: "issued",
        issue_request_id: "cir_1",
        issuer: "pomelo",
        program: "pomelo_brl",
        selection: { provider_requested: null, chosen_by: "currency" },
        card: POMELO_VIEW,
        authorization_id: "caia_1",
        authorization_active: true,
      },
    });
    const out = captureStdout();
    await cardCommand("issue", undefined, {
      ...AUTH,
      currency: "BRL",
      mandateId: "mnd_brl",
      consumerId: "cons_1",
      idempotencyKey: "idem_1",
      json: true,
    });
    expect(sent).toEqual([
      { tool: "codespar_card", input: { action: "issue", currency: "BRL", mandate_id: "mnd_brl", consumer_id: "cons_1", idempotency_key: "idem_1" } },
    ]);
    const doc = JSON.parse(out.text()) as Record<string, unknown>;
    expect(doc).toMatchObject({
      state: "issued",
      issuer: "pomelo",
      program: "pomelo_brl",
      card: { id: "icrd_1", currency: "BRL", status: "active", available_actions: ["freeze", "cancel"] },
    });
  });

  it("the human output names id, issuer, program, currency, status and available actions", async () => {
    backend({ success: true, error: null, data: POMELO_VIEW });
    const out = captureStdout();
    await cardCommand("get", "icrd_1", { ...AUTH });
    const text = out.text();
    for (const expected of ["icrd_1", "pomelo", "pomelo_brl", "BRL", "active (ACTIVE)", "freeze, cancel"]) {
      expect(text).toContain(expected);
    }
  });

  it("a pending_human issue is not a failure: the command ends normally and --json carries pending_action", async () => {
    backend({
      success: true,
      error: null,
      data: {
        state: "pending_human",
        issue_request_id: "cir_1",
        issuer: "rain",
        program: "rain_usd",
        pending_action: { id: "pa_1", kind: "accept_terms", actor: "holder", url: "https://codespar.dev/x" },
      },
    });
    const out = captureStdout();
    await expect(
      cardCommand("issue", undefined, { ...AUTH, currency: "USD", mandateId: "m", consumerId: "c", idempotencyKey: "k", json: true }),
    ).resolves.toBeUndefined();
    expect(JSON.parse(out.text())).toMatchObject({ state: "pending_human", pending_action: { kind: "accept_terms", actor: "holder" } });
  });

  it("a refusal throws an HttpError with the refusal's code and the whole refusal as body", async () => {
    backend({
      success: false,
      error: "freeze is not supported on rain_usd",
      data: {
        error: { code: "card_action_unsupported", message: "freeze is not supported on rain_usd", details: { issuer: "rain", program: "rain_usd", action: "freeze", available_actions: [] } },
        http_status: 422,
      },
    });
    captureStdout();
    const err = await cardCommand("freeze", "rcrd_1", { ...AUTH, json: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    const http = err as HttpError;
    expect(http.code).toBe("card_action_unsupported");
    expect(http.status).toBe(422);
    expect(http.message).toMatch(/card freeze refused: card_action_unsupported/);
    expect(http.body).toMatchObject({ state: "refused", issuer: "rain", available_actions: [] });
  });

  it.each(["uncertain", "processing"] as const)(
    "%s: says it resolves on the SAME key and never suggests another one (contract §8.3)",
    async (state) => {
      backend({ success: true, error: null, data: { state, issue_request_id: "cir_9", issuer: "rain", program: "rain_usd" } });
      const out = captureStdout();
      await expect(
        cardCommand("issue", undefined, { ...AUTH, currency: "USD", mandateId: "m", consumerId: "c", idempotencyKey: "k" }),
      ).resolves.toBeUndefined();
      const text = out.err();
      expect(text).toContain("cir_9");
      expect(text).toMatch(/same --idempotency-key/i);
      expect(text).not.toMatch(/(try again|retry|run it again) with (a )?(new|another|different) key/i);
      if (state === "uncertain") {
        expect(text).toMatch(/MAY exist/);
        expect(text).toMatch(/Do not use a new key/);
      }
    },
  );

  it("failed is a definitive refusal: HttpError with the issuer's code", async () => {
    backend({ success: true, error: null, data: { state: "failed", issue_request_id: "cir_8", issuer: "pomelo", program: "pomelo_brl", code: "issuer_declined" } });
    captureStdout();
    const err = await cardCommand("issue", undefined, { ...AUTH, currency: "BRL", mandateId: "m", consumerId: "c", idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("issuer_declined");
  });

  it("issue without --idempotency-key never reaches the network", async () => {
    const { sent } = backend({ success: true, error: null, data: POMELO_VIEW });
    await expect(
      cardCommand("issue", undefined, { ...AUTH, currency: "BRL", mandateId: "m", consumerId: "c" }),
    ).rejects.toThrow(CliError);
    expect(sent).toHaveLength(0);
  });
});

describe("codespar card readiness", () => {
  it("GETs /v1/cards/readiness and prints the document in --json", async () => {
    const doc = { programs: [{ program: "pomelo_brl", issuer: "pomelo", currency: "BRL", ready: true, requirements: [] }] };
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } }));
    });
    const out = captureStdout();
    await cardReadinessCommand({ ...AUTH, json: true });
    expect(urls).toEqual(["https://api.test.dev/v1/cards/readiness"]);
    expect(JSON.parse(out.text())).toEqual(doc);
  });
});

describe("codespar issue (deprecated, contract §8.4)", () => {
  it("warns and sends codespar_card for a new-shaped call", async () => {
    const { sent } = backend({ success: true, error: null, data: POMELO_VIEW });
    const out = captureStdout();
    await issueDeprecatedCommand({ ...AUTH, input: '{"action":"get","card_id":"icrd_1"}', json: true });
    expect(out.err()).toMatch(/`codespar issue` is deprecated; use `codespar card/);
    expect(sent).toEqual([{ tool: "codespar_card", input: { action: "get", card_id: "icrd_1" } }]);
  });

  it("refuses the old Pomelo shape with card_contract_migration_required, nothing sent", async () => {
    const { sent } = backend({ success: true, error: null, data: POMELO_VIEW });
    captureStdout();
    const err = await issueDeprecatedCommand({
      ...AUTH,
      input: '{"action":"card-virtual","cardholder_id":"usr_123","program_id":"afg_123"}',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe("card_contract_migration_required");
    expect((err as Error).message).toMatch(/codespar card issue --currency --mandate-id --consumer-id --idempotency-key/);
    expect(sent).toHaveLength(0);
  });
});
