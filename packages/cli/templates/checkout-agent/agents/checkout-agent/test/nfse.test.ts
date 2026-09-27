/**
 * Checkout §4: the NFS-e is a second execution after `settled`, called by
 * code, that never moves the sale. A proven-unsent attempt is retried; an
 * issuer refusal is terminal; anything else is `invoice_uncertain` and is
 * never sent again.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore, type ExecutionEngine } from "@codespar/agent-core";
import { CodesparApiError } from "@codespar/sdk";
import { checkScenario, loadScenario, runScenario, setup, type ScenarioRun } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";
import { classifyExecuteAnswer, CodeSparInvoiceRail, InvoiceBook, resumeInvoices, type InvoiceRail, type InvoiceRecord, type NfseRequest } from "../src/modules/nfse-invoice.js";

const runsDir = mkdtempSync(join(tmpdir(), "checkout-nfse-runs-"));
const events = (run: ScenarioRun) => readFileSync(join(run.bundle_dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string; execution_id?: string | null; actor?: unknown; payload?: Record<string, unknown> });

async function scenario(name: string, mode: "human" | "mandate" = "human") {
  const stateDir = mkdtempSync(join(tmpdir(), `checkout-nfse-${name}-`));
  const run = await runScenario(agent, loadScenario(agent, name), { mode, runsDir, stateDir });
  const store = new StateStore(join(stateDir, "state.db"));
  const invoices = new InvoiceBook(store).all();
  const outbox = store.listOutbox().filter((o) => o.kind === "nfse.issue");
  store.close();
  return { run, invoices, outbox, stateDir };
}

const ENV = "CHECKOUT_STUB_ISSUER";
afterEach(() => {
  delete process.env[ENV];
});

describe("checkout §4: the paid order opens its service invoice, and the invoice never moves the sale", () => {
  it("codespar_invoice is not the model's: it is not in tools.json and no handler answers it (checkout §7.3, point 4)", () => {
    const tools = JSON.parse(readFileSync(join(agent.dir, "tools.json"), "utf8")) as { meta_tools: Array<{ name: string }>; local_tools: Array<{ name: string }> };
    expect([...tools.meta_tools, ...tools.local_tools].map((t) => t.name)).not.toContain("codespar_invoice");
    const s = setup(agent, { rail: "stub", provider: "replay", transcript: "unused", stateDir: mkdtempSync(join(tmpdir(), "checkout-nfse-tools-")), runsDir, say: () => undefined });
    try {
      expect(Object.keys(s.handlers)).not.toContain("codespar_invoice");
    } finally {
      s.close();
    }
  });

  it("happy-path: one NFS-e per paid order, issued from the order's own data, and the customer is told about the order only", async () => {
    const { run, invoices, outbox } = await scenario("happy-path");
    expect(run.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(invoices).toHaveLength(1);
    const [invoice] = invoices;
    expect(invoice).toMatchObject({ sale_execution_id: run.executions[0]!.id, state: "accepted", attempts: 1, charge_id: run.executions[0]!.charge_ids[0] });
    expect(invoice!.document?.id).toMatch(/^nfse_stub_/);
    expect(invoice!.history.map((h) => h.to)).toEqual(["pending", "issuing", "accepted"]);
    expect(outbox).toEqual([expect.objectContaining({ status: "done", execution_id: invoice!.id })]);
    const all = events(run);
    const dispatched = all.filter((e) => e.type === "invoice.dispatch");
    expect(dispatched).toHaveLength(1);
    // What was PAID is what is invoiced, in the major units the meta-tool reads.
    expect(dispatched[0]!.payload!["services_amount"]).toBe(479.9);
    expect(all.filter((e) => e.type === "message.debtor")).toHaveLength(1);
    expect(all.filter((e) => e.type === "message.attendant")).toHaveLength(0);
    for (const e of all) expect(e.actor).toBeDefined();
  });

  it("nfse-failed: a refusal ends invoice_refused with the issuer's code; a timeout ends invoice_uncertain and is not sent again; both sales stay paid", async () => {
    for (const mode of ["human", "mandate"] as const) {
      const { run, invoices, outbox } = await scenario("nfse-failed", mode);
      expect(checkScenario(loadScenario(agent, "nfse-failed"), run).failures).toEqual([]);
      expect(run.executions.map((e) => e.state)).toEqual(["settled", "settled"]);
      const [refused, uncertain] = invoices;
      expect(refused).toMatchObject({ state: "failed", reason: "invoice_refused", code: "E0101", attempts: 1 });
      expect(uncertain).toMatchObject({ state: "failed", reason: "invoice_uncertain", code: "timeout", attempts: 1 });
      expect(outbox.map((o) => o.status)).toEqual(["failed", "failed"]);
      const all = events(run);
      // The attendant is told about each failure; the customers are told about their orders, twice in all, never about an invoice.
      expect(all.filter((e) => e.type === "message.attendant").map((e) => e.payload!["reason"])).toEqual(["invoice_refused", "invoice_uncertain"]);
      const told = all.filter((e) => e.type === "message.debtor").map((e) => String(e.payload!["text"]));
      expect(told).toHaveLength(2);
      for (const text of told) expect(text).not.toMatch(/nota|NFS-e|fiscal/i);
      // Nothing moved the sale after it settled.
      const settledAt = all.filter((e) => e.type === "execution.transition" && e.payload!["to"] === "settled").length;
      expect(settledAt).toBe(2);
      expect(all.filter((e) => e.type === "invoice.dispatch")).toHaveLength(2);
    }
  });

  it("a timed-out issuance is NOT re-sent by resume: the stub issuer did authorize a note, and a second call would mint another", async () => {
    const { invoices, stateDir } = await scenario("nfse-failed");
    const calls: string[] = [];
    const counting: InvoiceRail = { name: "stub-nfse", issue: async (_r, key) => (calls.push(key), { status: "accepted", document_id: "second", document_status: "X", pdf_url: null }) };
    const s = setup(agent, { rail: "stub", provider: "replay", transcript: "unused", stateDir, runsDir, say: () => undefined });
    try {
      const resumed = await resumeInvoices({ store: s.store, engine: s.engine, rail: counting, cart: () => undefined, say: () => undefined });
      expect(resumed).toEqual([]);
      expect(calls).toEqual([]);
      const store = s.store;
      expect(store.getCursor(`stub-nfse:${invoices[1]!.idempotency_key}`)).toBeDefined();
    } finally {
      s.close();
    }
  });

  it("an attempt proven unsent is retried under the same key, and stops at the bound", async () => {
    process.env[ENV] = "unsent_once";
    const once = await scenario("happy-path");
    expect(once.invoices[0]).toMatchObject({ state: "accepted", attempts: 2 });
    expect(once.invoices[0]!.history.map((h) => h.to)).toEqual(["pending", "issuing", "pending", "issuing", "accepted"]);

    process.env[ENV] = "unsent";
    const never = await scenario("happy-path");
    expect(never.invoices[0]).toMatchObject({ state: "failed", reason: "invoice_unsent", code: "no_eligible_providers", attempts: 3 });
    expect(never.run.executions.map((e) => e.state)).toEqual(["settled"]);
  });

  it("a crash after the request left (the record says issuing) is reconciled as uncertain by resume, and nothing is sent", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "checkout-nfse-crash-"));
    const s = setup(agent, { rail: "stub", provider: "replay", transcript: "unused", stateDir, runsDir, say: () => undefined });
    try {
      const record: InvoiceRecord = { id: "inv_crash", sale_execution_id: "exe_crash", cart_ref: "run/cart-1", charge_id: "chg_1", idempotency_key: "nfse_crash", state: "issuing", attempts: 1, history: [], created_at: "2026-09-23T18:00:00.000Z", updated_at: "2026-09-23T18:00:00.000Z" };
      new InvoiceBook(s.store).save(record);
      s.store.putOutbox({ idempotency_key: "nfse_crash", execution_id: "inv_crash", kind: "nfse.issue", payload: {}, status: "sent", response: undefined, created_at: record.created_at });
      const calls: string[] = [];
      const said: string[] = [];
      const [after] = await resumeInvoices({ store: s.store, engine: s.engine as ExecutionEngine, rail: { name: "stub-nfse", issue: async (_r, k) => (calls.push(k), { status: "accepted", document_id: "x", document_status: "X", pdf_url: null }) }, cart: () => undefined, say: (l) => said.push(l) });
      expect(after).toMatchObject({ state: "failed", reason: "invoice_uncertain", code: "interrupted" });
      expect(calls).toEqual([]);
      expect(said.join(" ")).toContain("INCERTO");
      expect(s.store.getOutbox("nfse_crash")?.status).toBe("failed");
    } finally {
      s.close();
    }
  });
});

describe("the wire, read by structure and code (codespar_invoice through POST /v1/sessions/{id}/execute)", () => {
  it("classifies every answer the route can give", () => {
    expect(classifyExecuteAnswer({ success: true, data: { id: "nf_1", status: "WAITINGSEND" }, error: null })).toMatchObject({ status: "accepted", document_id: "nf_1" });
    // A success that names no document may still have minted one.
    expect(classifyExecuteAnswer({ success: true, data: {}, error: null }).status).toBe("uncertain");
    // provider_error is raised for an issuer 4xx AND for a timeout or a 5xx; the wire does not say which.
    expect(classifyExecuteAnswer({ success: false, data: { error: "provider nfe-io returned status=400", code: "provider_error" }, error: "x", server: "unknown" }).status).toBe("uncertain");
    for (const code of ["no_eligible_providers", "credential_unavailable", "invalid_args", "org_paused", "tool_unknown"]) {
      expect(classifyExecuteAnswer({ success: false, data: { error: "x", code }, error: "x", server: "unknown" }).status).toBe("unsent");
    }
    expect(classifyExecuteAnswer({ success: false, data: { error: "x", code: "scope_missing" }, error: "x", server: "agentgate" }).status).toBe("unsent");
    expect(classifyExecuteAnswer({ success: false, data: null, error: "Tool not registered: codespar_invoice", server: "" }).status).toBe("unsent");
    // An unexpected throw inside the strategy answers output null: nobody can say.
    expect(classifyExecuteAnswer({ success: false, data: null, error: "boom", server: "unknown" }).status).toBe("uncertain");
    // The day the wire carries the provenance, it decides.
    expect(classifyExecuteAnswer({ success: false, data: { code: "provider_error", dispatch: "rejected" }, error: "x", server: "unknown" }).status).toBe("refused");
    expect(classifyExecuteAnswer({ success: false, data: { code: "provider_error", dispatch: "unsent" }, error: "x", server: "unknown" }).status).toBe("unsent");
  });

  it("the API rail: a session that will not open sent nothing; a 4xx from the route sent nothing; a timeout or a 5xx may have", async () => {
    const request = { action: "issue", type: "nfse" } as NfseRequest;
    const failing = (status: number, onSession = false) =>
      new CodeSparInvoiceRail({
        post: async (path: string) => {
          if (path === "/v1/sessions" && !onSession) return { id: "ses_1" };
          throw new CodesparApiError(`http ${status}`, { status });
        },
      } as never);
    expect((await failing(503, true).issue(request)).status).toBe("unsent");
    expect((await failing(403).issue(request)).status).toBe("unsent");
    expect((await failing(503).issue(request)).status).toBe("uncertain");
    const answered = new CodeSparInvoiceRail({ post: async (path: string, init: { body: { tool?: string; input?: unknown } }) => (path === "/v1/sessions" ? { id: "ses_1" } : { success: true, data: { id: "nf_9", status: "PROCESSING", tool: init.body.tool }, error: null, server: "nfe-io" }) } as never);
    expect(await answered.issue(request)).toMatchObject({ status: "accepted", document_id: "nf_9", document_status: "PROCESSING" });
  });
});
