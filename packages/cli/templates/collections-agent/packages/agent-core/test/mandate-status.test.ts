/**
 * Section 4.7 against the real client: `ApiMandateStatusSource` reads
 * `GET /v1/mandates/{id}` on a mocked HTTP server, and the engine is driven
 * through it. Every answer but `active` must keep `rail.pay` from ever
 * being called, and a read that does not answer must refuse too. The
 * organization kill switch (ent#1648) rides on the same read as `org_paused`,
 * and the spend route refuses 403 `org_paused` on its own when the switch is
 * pressed after the read.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { ApiMandateStatusSource } from "../src/api/mandate-status.js";
import { CodeSparRail } from "../src/api/rail.js";
import type { MandateStatusSource } from "../src/revocation.js";
import { harness, type Harness } from "./helpers.js";

const MANDATE_ID = "mdt_test_0001";
const NOW = new Date("2026-09-23T18:00:00Z");
const approver = { id: "usr_demo_titular", channel: "terminal" };

/** The 14-field projection `GET /v1/mandates/{id}` answers (measured on staging, 2026-09-23), plus the two kill-switch fields of ent#1648. */
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
    org_paused: false,
    org_paused_at: null,
    ...over,
  };
}

type Answer = { status: number; body?: unknown; hang?: boolean };

let server: Server;
let baseUrl: string;
let next: Answer = { status: 200, body: mandateBody() };
/** What a POST (the spend) answers, when a test sends one; the mandate read keeps answering `next`. */
let spendNext: Answer | undefined;
const requests: Array<{ method: string; url: string; bearerIsTestKey: boolean }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", bearerIsTestKey: (req.headers.authorization ?? "").startsWith("Bearer csk_test_") });
    const answer = req.method === "POST" && spendNext ? spendNext : next;
    if (answer.hang) return; // never answers: the client's timeout is the only way out
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
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
  spendNext = undefined;
  requests.length = 0;
});

function apiClient(timeoutMs = 5_000) {
  // The placeholder passes the `csk_test_` guard and is the one test-key-shaped string the secret scan allows.
  return createCodeSparClient({ apiKey: "csk_test_your_key_here", baseUrl, timeoutMs });
}

function apiSource(timeoutMs = 5_000): ApiMandateStatusSource {
  return new ApiMandateStatusSource(apiClient(timeoutMs), () => NOW);
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

});

describe("the organization kill switch (ent#1648): org_paused on the read, 403 org_paused on the spend", () => {
  const PAUSED = { org_paused: true, org_paused_at: "2026-09-23T17:30:00.000Z" };

  it("the source reports org_paused as the API says it, and keeps the mandate's own status next to it", async () => {
    next = { status: 200, body: mandateBody(PAUSED) };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "active", org_paused: true, source: "api" });
  });

  it("org_paused missing, or not a boolean, is unknown: never read as a running organization", async () => {
    const { org_paused: _dropped, ...withoutFlag } = mandateBody();
    next = { status: 200, body: withoutFlag };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "unknown", org_paused: false, detail: expect.stringContaining("org_paused") });
    next = { status: 200, body: mandateBody({ org_paused: "false" }) };
    expect(await apiSource().check(MANDATE_ID)).toMatchObject({ status: "unknown", detail: expect.stringContaining("org_paused") });
    next = { status: 200, body: mandateBody({ org_paused: null }) };
    expect((await apiSource().check(MANDATE_ID)).status).toBe("unknown");
  });

  it("paused before execute: the gate denies (org_paused) whatever status says, no outbox row, rail.pay never called", async () => {
    const h = apiHarness();
    const id = await approvedThen(h, { status: 200, body: mandateBody(PAUSED) });
    const out = await h.engine.execute(id);
    expect(out).toMatchObject({ state: "denied", reason: "org_paused" });
    expect(h.store.listOutbox()).toHaveLength(0);
    expect(h.rail.payCount).toBe(0);
    expect(await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] })).toMatchObject({ ok: false, refused_before_draft: true, reason: "org_paused" });
  });

  it("a read without org_paused after approval: denied (mandate_status_unavailable), rail.pay never called", async () => {
    const h = apiHarness();
    const { org_paused: _dropped, ...withoutFlag } = mandateBody();
    const id = await approvedThen(h, { status: 200, body: withoutFlag });
    const out = await h.engine.execute(id);
    expect(out).toMatchObject({ state: "denied", reason: "mandate_status_unavailable" });
    expect(out.detail).toContain("org_paused");
    expect(h.rail.payCount).toBe(0);
  });

  // Paused between the gate and the spend: the read said running, the API refuses the spend itself before any hold.
  // The execution is already `executing`, and section 4.7 closes that state as `settled` or `failed` only: no new edge.
  const spendRefusals: Array<[string, unknown]> = [
    ["the documented envelope", { error: { code: "org_paused", message: "the organization paused all agent spend (kill switch)" }, request_id: null }],
    ["the flat body the guardrail sends", { error: "org_paused", message: "the organization paused all agent spend (kill switch)" }],
  ];
  for (const [shape, body] of spendRefusals) {
    it(`paused between the gate and the spend, 403 org_paused (${shape}): failed (org_paused), and nothing but the read and the one spend reached the API`, async () => {
      const h = harness({ mode: "mandate", now: NOW, manifest: { escalate_above: {} }, guardrails: { escalate_above: {} }, status: apiSource(), wrapRail: () => new CodeSparRail(apiClient()) });
      const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
      if (!d.ok) throw new Error(`refused before draft: ${d.reason}`);
      spendNext = { status: 403, body };
      const out = await h.engine.execute(d.execution.id);
      expect(out.state).toBe("failed");
      expect(out.reason).toBe("org_paused");
      expect(out.history.at(-1)).toMatchObject({ from: "executing", to: "failed", reason: "org_paused" });
      expect(out.outcomes).toEqual([expect.objectContaining({ status: "failed", code: "org_paused" })]);
      expect(out.outcomes.some((o) => "receipt_id" in o || "transaction_id" in o)).toBe(false);
      expect(h.store.listOutbox({ execution_id: out.id })).toEqual([expect.objectContaining({ status: "failed" })]);
      // No receipt read, no ledger or fund call, no second spend: the mandate read(s) and exactly one POST.
      const spend = `/v1/consumers/mandates/${out.mandate.id}/spend`;
      expect(requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual([spend]);
      expect(requests.filter((r) => !(r.method === "GET" && r.url === `/v1/mandates/${out.mandate.id}`) && r.url !== spend)).toEqual([]);
    });
  }
});
