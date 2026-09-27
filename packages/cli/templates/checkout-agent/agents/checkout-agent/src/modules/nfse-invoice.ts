/**
 * Module `nfse-invoice`: the service invoice (NFS-e) of a PAID order, as an
 * execution of its own (checkout §4, decision 4).
 *
 * The invoice is not a state of the sale. The sale ends in `settled`; when it
 * does, this module opens a second execution with its own outbox row and
 * calls `codespar_invoice` BY CODE — the model never reaches it, because a
 * fiscal document is irreversible and must not be one sentence away from the
 * customer. The two executions refer to each other by the cart and the
 * charge, and nothing either one does moves the other: a paid order stays
 * paid whatever the invoice does, and the customer is never told about the
 * invoice.
 *
 * The retry rule is the core's outbox rule, applied to a document instead of
 * money. The outbox row flips to `sent` BEFORE the call. An answer that
 * proves nothing reached the issuer (`unsent`) is retried, a bounded number
 * of times. An issuer refusal is terminal for the attempt and goes to the
 * attendant with the issuer's code. ANYTHING else — a timeout, a 5xx, a
 * provider error the wire does not qualify, a crash after `sent` — may have
 * authorized a note, and ends `failed (invoice_uncertain)` for a person to
 * reconcile. It is never sent again: the issuance carries no idempotency key
 * and the meta-tool cannot read an NFS-e back (checkout §9.14, ent#1675), so
 * a blind retry can mint a second irreversible document for the same sale.
 */
import { randomBytes } from "node:crypto";
import { describeApiError, type Execution, type ExecutionEngine, type StateStore } from "@codespar/agent-core";
import type { ApiClient } from "@codespar/sdk";
import { catalogItem, customerByDocument, formatBRL, MERCHANT, type Customer } from "../catalog.js";
import type { Cart } from "./storefront-cart.js";

/**
 * `accepted` is the issuer taking the request and naming a document: the
 * municipal AUTHORIZATION that follows is not readable through the
 * meta-tool (checkout §9.14), so this module never claims it.
 */
export type InvoiceState = "pending" | "issuing" | "accepted" | "failed";
export type InvoiceReason = "invoice_refused" | "invoice_unsent" | "invoice_uncertain";

export interface InvoiceRecord {
  id: string;
  /** The sale this invoice follows, and what ties the two: the cart and the charge. */
  sale_execution_id: string;
  cart_ref: string;
  charge_id: string | null;
  /** The outbox row's key. One per invoice; a retry of an `unsent` attempt reuses it. */
  idempotency_key: string;
  state: InvoiceState;
  reason?: InvoiceReason;
  /** The issuer's code (a refusal) or the transport's (anything else). */
  code?: string;
  detail?: string;
  attempts: number;
  document?: { id: string; status: string; pdf_url: string | null };
  history: Array<{ from: InvoiceState | null; to: InvoiceState; at: string; reason?: InvoiceReason; code?: string }>;
  created_at: string;
  updated_at: string;
}

/** What `codespar_invoice action=issue type=nfse` is asked. Built from the paid order, never from the conversation. */
export interface NfseRequest {
  action: "issue";
  type: "nfse";
  recipient: {
    name: string;
    federalTaxNumber: string;
    email: string;
    address?: { country: "BRA"; postalCode: string; street: string; number: string; district: string; city: { code: string; name: string }; state: string };
  };
  items: Array<{ description: string; quantity: number; unit_price: number; service_code: string }>;
  metadata: { description: string; servicesAmount: number; additionalInformation: string };
}

export type InvoiceOutcome =
  | { status: "accepted"; document_id: string; document_status: string; pdf_url: string | null }
  /** Proven not to have reached the issuer: the request was refused before any provider call. Retried. */
  | { status: "unsent"; code: string; message: string }
  /** The issuer answered and refused. Nothing was issued; the same data would be refused again. */
  | { status: "refused"; code: string; message: string }
  /** Nobody can say whether a note was authorized. Never retried. */
  | { status: "uncertain"; code: string; message: string };

export interface InvoiceRail {
  readonly name: "stub-nfse" | "codespar-nfse";
  issue(request: NfseRequest, key: string): Promise<InvoiceOutcome>;
}

export const MAX_INVOICE_ATTEMPTS = 3;

/**
 * The strategy codes raised BEFORE the provider is called on the invoice
 * path (`meta-tools/real-strategy.ts`, `strategy-error.ts` at enterprise
 * main): routing found no provider, the transform or tool is unknown, the
 * credential did not resolve, the arguments did not coerce, the organization
 * is paused. `provider_error` is NOT here: it is raised both for a 4xx the
 * issuer answered and for a timeout or a 5xx, and the wire does not say which
 * (OPEN_QUESTIONS §58).
 */
const PRE_DISPATCH_CODES = new Set(["no_eligible_providers", "transform_unknown", "tool_unknown", "credential_unavailable", "invalid_args", "org_paused"]);

/**
 * `codespar_invoice` through the REST twin of a session: `POST /v1/sessions`,
 * then `POST /v1/sessions/{id}/execute` with the meta-tool's own name and
 * input. The kit runs no MCP session of its own; this is the same call an
 * agent's `codespar_invoice` makes, made by code.
 */
export class CodeSparInvoiceRail implements InvoiceRail {
  readonly name = "codespar-nfse" as const;
  private sessionId: string | undefined;

  constructor(private readonly api: ApiClient) {}

  async issue(request: NfseRequest): Promise<InvoiceOutcome> {
    if (!this.sessionId) {
      try {
        const session = await this.api.post("/v1/sessions", { body: { servers: ["nfe-io"] } });
        this.sessionId = session.id;
      } catch (err) {
        // Opening a session sends no document, whatever the answer was.
        const f = describeApiError(err);
        return { status: "unsent", code: f.code, message: `the session could not be opened: ${f.message}` };
      }
    }
    let answer: { success: boolean; data?: unknown; error: string | null; server?: string };
    try {
      answer = await this.api.post("/v1/sessions/{id}/execute", { path: { id: this.sessionId! }, body: { tool: "codespar_invoice", input: request as unknown as Record<string, unknown> } });
    } catch (err) {
      const f = describeApiError(err);
      // The route answered and refused the request (schema, auth, policy, rate): no tool ran. Anything else may have dispatched.
      if (f.status >= 400 && f.status < 500) return { status: "unsent", code: f.code, message: f.message };
      return { status: "uncertain", code: f.code, message: `${f.message}; the issuance may have reached the issuer` };
    }
    return classifyExecuteAnswer(answer);
  }
}

/** The execute envelope, read by its structure and its codes, never by its prose. Exported for the tests. */
export function classifyExecuteAnswer(answer: { success: boolean; data?: unknown; error: string | null; server?: string }): InvoiceOutcome {
  const data = (answer.data ?? null) as Record<string, unknown> | null;
  if (answer.success) {
    const id = typeof data?.["id"] === "string" && data["id"] ? data["id"] : undefined;
    if (!id) return { status: "uncertain", code: "invoice_unreadable", message: "the issuer answered success without a document id; a note may exist and nothing here can name it" };
    return { status: "accepted", document_id: id, document_status: typeof data?.["status"] === "string" ? data["status"] : "UNKNOWN", pdf_url: typeof data?.["danfe_url"] === "string" ? data["danfe_url"] : null };
  }
  const code = typeof data?.["code"] === "string" ? data["code"] : "unknown";
  const message = answer.error ?? (typeof data?.["error"] === "string" ? data["error"] : "no message");
  // Forward-compatible: the strategy knows the provenance (`dispatch`) and today does not put it on the wire. The day it does, it decides.
  if (data?.["dispatch"] === "unsent") return { status: "unsent", code, message };
  if (data?.["dispatch"] === "rejected") return { status: "refused", code, message };
  // A policy or scope refusal is ours, not the issuer's: nothing was dispatched.
  if (answer.server === "agentgate" || answer.server === "") return { status: "unsent", code, message };
  if (PRE_DISPATCH_CODES.has(code)) return { status: "unsent", code, message };
  return { status: "uncertain", code, message };
}

export type StubIssuerBehaviour = "issues" | "refuses" | "times_out" | "unsent_once" | "unsent";

/**
 * STUB issuer. Offline, deterministic, persisted in state.db so a killed
 * process finds what it issued. It applies one rule a real issuer applies —
 * a borrower without an address is refused — and one script of its own:
 * Beatriz's invoice times out AFTER the request left, which is the case
 * nobody can settle from the answer. `behaviour` overrides both (a test).
 */
export class StubInvoiceRail implements InvoiceRail {
  readonly name = "stub-nfse" as const;
  private unsentPending = true;

  constructor(
    private readonly store: StateStore,
    private readonly behaviour?: StubIssuerBehaviour,
  ) {}

  async issue(request: NfseRequest, key: string): Promise<InvoiceOutcome> {
    const behaviour = this.behaviour ?? (request.recipient.federalTaxNumber === "43091752879" ? "times_out" : undefined);
    if (behaviour === "unsent") return { status: "unsent", code: "no_eligible_providers", message: "stub: this organization has no issuer connected; nothing was sent" };
    if (behaviour === "unsent_once" && this.unsentPending) {
      this.unsentPending = false;
      return { status: "unsent", code: "no_eligible_providers", message: "stub: routing found no issuer this time; nothing was sent" };
    }
    if (behaviour === "refuses" || (behaviour === undefined && !request.recipient.address)) {
      return { status: "refused", code: "E0101", message: "stub issuer: tomador sem endereco; a NFS-e exige o endereco do tomador" };
    }
    // What the issuer did is recorded before the answer is lost, as a real one would have.
    const documentId = `nfse_stub_${key.slice(-16)}`;
    this.store.setCursor(`stub-nfse:${key}`, JSON.stringify({ document_id: documentId, request }));
    if (behaviour === "times_out") return { status: "uncertain", code: "timeout", message: "stub issuer: no answer within the timeout; the request had left" };
    return { status: "accepted", document_id: documentId, document_status: "WAITINGSEND", pdf_url: null };
  }

  /** Test hook: what the stub issuer holds for a key (a note it authorized, whether or not anybody heard back). */
  issued(key: string): string | undefined {
    const raw = this.store.getCursor(`stub-nfse:${key}`);
    return raw ? (JSON.parse(raw) as { document_id: string }).document_id : undefined;
  }
}

const KEY = (saleId: string) => `checkout:invoice:${saleId}`;
const INDEX = "checkout:invoices";

/** The invoices, in state.db's key-value table; their outbox rows in the core's outbox table (`kind: nfse.issue`). */
export class InvoiceBook {
  constructor(private readonly store: StateStore) {}

  of(saleId: string): InvoiceRecord | undefined {
    const raw = this.store.getCursor(KEY(saleId));
    return raw ? (JSON.parse(raw) as InvoiceRecord) : undefined;
  }

  all(): InvoiceRecord[] {
    const raw = this.store.getCursor(INDEX);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    return ids.map((id) => this.of(id)).filter((r): r is InvoiceRecord => r !== undefined);
  }

  save(record: InvoiceRecord): void {
    this.store.setCursor(KEY(record.sale_execution_id), JSON.stringify(record));
    const raw = this.store.getCursor(INDEX);
    const ids = raw ? (JSON.parse(raw) as string[]) : [];
    if (!ids.includes(record.sale_execution_id)) this.store.setCursor(INDEX, JSON.stringify([...ids, record.sale_execution_id]));
  }
}

export interface InvoiceDeps {
  store: StateStore;
  engine: ExecutionEngine;
  rail: InvoiceRail;
  cart(ref: string): Cart | undefined;
  /** The attendant's console. The customer is never told about the invoice. */
  say(line: string): void;
}

/** The request, from the paid order: the customer book's fiscal data, the cart's lines, the total that was paid. */
export function nfseRequest(sale: Execution, cart: Cart, customer: Customer): NfseRequest {
  const chargeId = sale.outcomes[0]?.transaction_id ?? "?";
  return {
    action: "issue",
    type: "nfse",
    recipient: {
      name: customer.name,
      federalTaxNumber: customer.document,
      email: customer.email,
      ...(customer.address
        ? { address: { country: "BRA" as const, postalCode: customer.address.postal_code, street: customer.address.street, number: customer.address.number, district: customer.address.district, city: { code: customer.address.city_code, name: customer.address.city }, state: customer.address.state } }
        : {}),
    },
    items: cart.line_items.map((l) => ({ description: l.name, quantity: l.quantity, unit_price: l.unit_amount / 100, service_code: catalogItem(l.sku)?.service_code ?? "" })),
    metadata: {
      description: `${MERCHANT.name} - pedido ${cart.cart_id}: ${cart.line_items.map((l) => `${l.quantity}x ${l.name}`).join("; ")}`,
      // What was PAID, discounts included; the transform would otherwise sum list prices.
      servicesAmount: sale.total / 100,
      additionalInformation: `cobranca ${chargeId}, ${formatBRL(sale.total)}`,
    },
  };
}

function transition(record: InvoiceRecord, to: InvoiceState, deps: InvoiceDeps, extra: { reason?: InvoiceReason; code?: string; detail?: string } = {}): InvoiceRecord {
  const at = deps.engine.clock().toISOString();
  const { reason: _r, code: _c, detail: _d, ...rest } = record;
  const next: InvoiceRecord = { ...rest, state: to, ...extra, updated_at: at, history: [...record.history, { from: record.state, to, at, ...(extra.reason ? { reason: extra.reason } : {}), ...(extra.code ? { code: extra.code } : {}) }] };
  new InvoiceBook(deps.store).save(next);
  deps.engine.note("invoice.transition", record.sale_execution_id, { invoice_id: record.id, from: record.state, to, ...extra });
  return next;
}

/** Opens the invoice of a settled order, once. `undefined` for anything that is not a paid order. */
export function openInvoice(sale: Execution, deps: InvoiceDeps): InvoiceRecord | undefined {
  if (sale.state !== "settled" || !sale.composition) return undefined;
  const book = new InvoiceBook(deps.store);
  const existing = book.of(sale.id);
  if (existing) return existing;
  const at = deps.engine.clock().toISOString();
  const record: InvoiceRecord = {
    id: `inv_${randomBytes(8).toString("hex")}`,
    sale_execution_id: sale.id,
    cart_ref: sale.composition.ref,
    charge_id: sale.outcomes[0]?.transaction_id ?? null,
    idempotency_key: `nfse_${sale.idempotency_key.slice(4)}`,
    state: "pending",
    attempts: 0,
    history: [{ from: null, to: "pending", at }],
    created_at: at,
    updated_at: at,
  };
  book.save(record);
  deps.store.putOutbox({ idempotency_key: record.idempotency_key, execution_id: record.id, kind: "nfse.issue", payload: { sale_execution_id: sale.id, cart_ref: record.cart_ref, charge_id: record.charge_id }, status: "pending", response: undefined, created_at: at });
  deps.engine.note("invoice.opened", sale.id, { invoice_id: record.id, cart_ref: record.cart_ref, charge_id: record.charge_id, idempotency_key: record.idempotency_key });
  return record;
}

/**
 * Sends a `pending` invoice. The outbox flips to `sent` before each call, so
 * a crash after that point is reconciled as uncertain and never re-sent.
 */
export async function dispatchInvoice(record: InvoiceRecord, deps: InvoiceDeps): Promise<InvoiceRecord> {
  let current = record;
  const sale = deps.engine.get(record.sale_execution_id);
  const cart = deps.cart(record.cart_ref);
  const customer = sale ? customerByDocument(sale.items[0]!.payee) : undefined;
  if (!sale || !cart || !customer) {
    // Nothing was sent: the order's own records do not resolve. A defect of this state, not the issuer's answer.
    deps.store.updateOutbox(record.idempotency_key, "failed", { code: "invoice_data_missing" }, deps.engine.clock().toISOString());
    return notify(transition(current, "failed", deps, { reason: "invoice_unsent", code: "invoice_data_missing", detail: "the paid order, its cart or its customer could not be read; nothing was sent" }), deps);
  }
  const request = nfseRequest(sale, cart, customer);
  while (current.state === "pending") {
    const attempt = current.attempts + 1;
    current = transition({ ...current, attempts: attempt }, "issuing", deps);
    deps.store.updateOutbox(record.idempotency_key, "sent", undefined, deps.engine.clock().toISOString());
    deps.engine.note("invoice.dispatch", sale.id, { invoice_id: record.id, attempt, rail: deps.rail.name, idempotency_key: record.idempotency_key, services_amount: request.metadata.servicesAmount });
    const outcome = await deps.rail.issue(request, record.idempotency_key);
    deps.engine.note("invoice.outcome", sale.id, { invoice_id: record.id, attempt, status: outcome.status, ...(outcome.status === "accepted" ? { document_id: outcome.document_id, document_status: outcome.document_status } : { code: outcome.code, message: outcome.message }) });
    const at = deps.engine.clock().toISOString();
    switch (outcome.status) {
      case "accepted":
        deps.store.updateOutbox(record.idempotency_key, "done", outcome, at);
        current = transition({ ...current, document: { id: outcome.document_id, status: outcome.document_status, pdf_url: outcome.pdf_url } }, "accepted", deps);
        break;
      case "unsent":
        if (attempt >= MAX_INVOICE_ATTEMPTS) {
          deps.store.updateOutbox(record.idempotency_key, "failed", outcome, at);
          current = notify(transition(current, "failed", deps, { reason: "invoice_unsent", code: outcome.code, detail: `${attempt} attempt(s), none reached the issuer: ${outcome.message}` }), deps);
        } else {
          // Proven not sent: the row goes back to pending, and the next attempt is the same request under the same key.
          deps.store.updateOutbox(record.idempotency_key, "pending", outcome, at);
          current = transition(current, "pending", deps, { code: outcome.code, detail: outcome.message });
        }
        break;
      case "refused":
        deps.store.updateOutbox(record.idempotency_key, "failed", outcome, at);
        current = notify(transition(current, "failed", deps, { reason: "invoice_refused", code: outcome.code, detail: outcome.message }), deps);
        break;
      case "uncertain":
        deps.store.updateOutbox(record.idempotency_key, "failed", outcome, at);
        current = notify(transition(current, "failed", deps, { reason: "invoice_uncertain", code: outcome.code, detail: `${outcome.message}. Not re-issued: the issuance has no idempotency key and the meta-tool cannot read an NFS-e back (ent#1675); reconcile at the issuer before issuing again.` }), deps);
        break;
    }
  }
  return current;
}

/** The attendant hears about a failed invoice; the customer never does. */
function notify(record: InvoiceRecord, deps: InvoiceDeps): InvoiceRecord {
  const text =
    record.reason === "invoice_uncertain"
      ? `NFS-e do pedido ${record.sale_execution_id} (cobranca ${record.charge_id}) com resultado INCERTO (${record.code}): pode ter sido emitida. Nao reemita; confira no emissor. A venda continua paga.`
      : `NFS-e do pedido ${record.sale_execution_id} (cobranca ${record.charge_id}) falhou (${record.reason}, ${record.code}): ${record.detail}. A venda continua paga.`;
  deps.say(`  [atendente] ${text}`);
  deps.engine.note("message.attendant", record.sale_execution_id, { invoice_id: record.id, state: record.state, reason: record.reason ?? null, code: record.code ?? null, text });
  return record;
}

/** After a sale's outcome: open its invoice if it was paid, and send it if it is pending. */
export async function followSale(sale: Execution, deps: InvoiceDeps): Promise<InvoiceRecord | undefined> {
  const record = openInvoice(sale, deps);
  if (!record || record.state !== "pending") return record;
  return dispatchInvoice(record, deps);
}

/**
 * `resume`: a `pending` invoice provably never left and is sent; one left
 * `issuing` was sent and never answered, which is exactly the uncertain case,
 * so it closes as `invoice_uncertain` and is NOT sent again.
 */
export async function resumeInvoices(deps: InvoiceDeps): Promise<InvoiceRecord[]> {
  const out: InvoiceRecord[] = [];
  for (const record of new InvoiceBook(deps.store).all()) {
    if (record.state === "pending") out.push(await dispatchInvoice(record, deps));
    else if (record.state === "issuing") {
      deps.store.updateOutbox(record.idempotency_key, "failed", { code: "interrupted" }, deps.engine.clock().toISOString());
      out.push(notify(transition(record, "failed", deps, { reason: "invoice_uncertain", code: "interrupted", detail: "the process stopped after the request was sent and before an answer was recorded" }), deps));
    }
  }
  return out;
}
