/**
 * Section 4.7 against the real client: `ApiMandateStatusSource` reads
 * `GET /v1/mandates/{id}` on a mocked HTTP server, and the engine is driven
 * through it. Every answer but `active` must keep `rail.pay` from ever
 * being called, and a read that does not answer must refuse too.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { ApiMandateStatusSource } from "../src/api/mandate-status.js";
import type { MandateStatusSource } from "../src/revocation.js";
import { harness, type Harness } from "./helpers.js";

const MANDATE_ID = "mdt_test_0001";
const NOW = new Date("2026-09-23T18:00:00Z");
const approver = { id: "usr_demo_titular", channel: "terminal" };

/** The 14-field projection `GET /v1/mandates/{id}` answers (measured on staging, 2026-09-23). */
function mandateBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MANDATE_ID,
    consumer_id: "usr_demo",
    agent_id: "bills-agent",
    display_name: null,
    purpose: "contas do mes",
    merchant_allowlist: ["escola@exemplo.com.br"],
    merchant_pin_kind: "pix-key",
    intent_note: null,
    cap_minor: "7200000",
    per_tx_cap_minor: "250000",
    currency: "BRL",
    status: "active",
    expires_at: "2027-09-23T00:00:00.000Z",
    created_at: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}

type Answer = { status: number; body?: unknown; hang?: boolean };

let server: Server;
let baseUrl: string;
let next: Answer = { status: 200, body: mandateBody() };
const requests: Array<{ method: string; url: string; bearerIsTestKey: boolean }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", bearerIsTestKey: (req.headers.authorization ?? "").startsWith("Bearer csk_test_") });
    if (next.hang) return; // never answers: the client's timeout is the only way out
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  next = { status: 200, body: mandateBody() };
  requests.length = 0;
});

function apiSource(timeoutMs = 5_000): ApiMandateStatusSource {
  // The placeholder passes the `csk_test_` guard and is the one test-key-shaped string the secret scan allows.
  return new ApiMandateStatusSource(createCodeSparClient({ apiKey: "csk_test_your_key_here", baseUrl, timeoutMs }), () => NOW);
}

function apiHarness(status: MandateStatusSource = apiSource()): Harness {
  return harness({ mode: "mandate", now: NOW, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, status });
}

/** Drafts and approves under `active`, then flips the API's answer: the last gate is what is under test. */
async function approvedThen(h: Harness, answer: Answer): Promise<string> {
  const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
  if (!d.ok) throw new Error(`refused before draft: ${d.reason}`);
  expect(d.execution.state).toBe("approved");
  next = answer;
  return d.execution.id;
}

describe("ApiMandateStatusSource reads GET /v1/mandates/{id} with the test key", () => {
  it("answers the status the API gives, on the one registered spelling of the route", async () => {
    const report = await apiSource().check(MANDATE_ID);
    expect(report).toMatchObject({ mandate_id: MANDATE_ID, status: "active", org_paused: false, source: "api" });
    expect(requests).toEqual([{ method: "GET", url: `/v1/mandates/${MANDATE_ID}`, bearerIsTestKey: true }]);
  });

  it("an active mandate past its expires_at is expired, whatever the status field says", async () => {
    next = { status: 200, body: mandateBody({ expires_at: "2026-09-23T17:59:59.000Z" }) };
    expect((await apiSource().check(MANDATE_ID)).status).toBe("expired");
  });

  it("never throws: 404, 500, a hung connection, a body without a readable status and a status outside the four are all `unknown`, with a reason", async () => {
    next = { status: 404, body: { error: { code: "mandate_not_found", message: "no such mandate" }, request_id: null } };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "unknown", detail: expect.stringContaining("no mandate") });
    next = { status: 500, body: { error: { code: "internal", message: "boom" } } };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "unknown", detail: expect.stringContaining("did not answer") });
    next = { status: 200, body: "not json at all" };
    expect((await apiSource().check(MANDATE_ID)).status).toBe("unknown");
    next = { status: 200, body: mandateBody({ status: "frozen" }) };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "unknown", detail: expect.stringContaining("frozen") });
    next = { status: 200, hang: true };
    expect(await apiSource(150).check(MANDATE_ID)).toMatchObject({ status: "unknown", detail: expect.stringContaining("timeout") });
  });
});

describe("section 4.7 through the engine, on the API source: executing only on active", () => {
  it("active: the approved execution reaches executing and settles on the rail", async () => {
    const h = apiHarness();
    const id = await approvedThen(h, { status: 200, body: mandateBody() });
    const out = await h.engine.execute(id);
    expect(out.state).toBe("settled");
    expect(h.rail.payCount).toBe(1);
  });

  const refusals: Array<[string, Answer, string, string]> = [
    ["paused", { status: 200, body: mandateBody({ status: "paused" }) }, "denied", "mandate_paused"],
    ["revoked", { status: 200, body: mandateBody({ status: "revoked" }) }, "denied", "mandate_revoked"],
    ["expired", { status: 200, body: mandateBody({ status: "expired" }) }, "expired", "mandate_expired"],
    ["500", { status: 500, body: { error: { code: "internal", message: "boom" } } }, "denied", "mandate_status_unavailable"],
    ["404", { status: 404, body: { error: { code: "mandate_not_found", message: "gone" } } }, "denied", "mandate_status_unavailable"],
    ["timeout", { status: 200, hang: true }, "denied", "mandate_status_unavailable"],
  ];
  for (const [name, answer, state, reason] of refusals) {
    it(`${name} after approval: ${state} (${reason}), no outbox row, rail.pay never called`, async () => {
      const h = apiHarness(name === "timeout" ? apiSource(150) : apiSource());
      const id = await approvedThen(h, answer);
      const out = await h.engine.execute(id);
      expect(out.state).toBe(state);
      expect(out.reason).toBe(reason);
      expect(out.detail).toContain(MANDATE_ID);
      expect(h.store.listOutbox()).toHaveLength(0);
      expect(h.rail.payCount).toBe(0);
      // A new request under the same answer is refused before anything is drafted.
      expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, refused_before_draft: true, reason });
      expect(h.store.listExecutions()).toHaveLength(1);
    });
  }

  it("a source that throws is fail-closed too: mandate_status_unavailable, rail.pay never called", async () => {
    const h = apiHarness({ check: async () => { throw new Error("socket hang up"); } });
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, reason: "mandate_status_unavailable" });
    expect(h.rail.payCount).toBe(0);
  });

  it("the API source never reports org_paused: the API has no kill-switch read, and the source does not invent one", async () => {
    expect((await apiSource().check(MANDATE_ID)).org_paused).toBe(false);
  });
});
