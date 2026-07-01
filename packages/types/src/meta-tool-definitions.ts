/* ── Shared meta-tool definitions ────────────────────────────────
 *
 * The agent-facing definition of a commerce meta-tool — its name, its
 * description, and the input schema the language model is shown — published
 * once here so every runtime presents the identical tool to the agent.
 *
 * An implementation registers behind a definition (e.g. on the OSS runtime
 * via a `MetaToolHook`); implementations differ, but the definition the agent
 * reasons over does not.
 * The `contract` field carries the conformance surface — the property names
 * and the required subset a conforming implementation must expose — so a
 * conformance test can assert any runtime's tool matches this definition
 * without comparing prose.
 *
 * Definitions are data, not code: they carry no routing and import nothing
 * runtime-specific, so they serialize cleanly and stay portable.
 * ─────────────────────────────────────────────────────────────── */

/** A single input property's wire description. */
export interface MetaToolInputProperty {
  /** JSON-value type: "string" | "number" | "boolean" | "object" | "array". */
  type: string;
  /** Human-readable description shown to the agent. */
  description?: string;
}

/** The JSON-Schema-shaped input contract an agent-facing meta-tool advertises. */
export interface MetaToolInputSchema {
  type: "object";
  properties: Record<string, MetaToolInputProperty>;
  /** Property names that must be supplied. */
  required?: readonly string[];
}

/**
 * The conformance surface of a definition: the property names a conforming
 * implementation must expose and the subset that is required. A conformance
 * test compares a live runtime's tool against this — structural, not prose —
 * so an implementation can be checked to present the same agent-facing tool as
 * this shared definition.
 */
export interface MetaToolConformanceContract {
  /** Every property name the agent-facing tool exposes. */
  properties: readonly string[];
  /** The subset of `properties` that is required. */
  required: readonly string[];
}

/** A shared, runtime-agnostic agent-facing meta-tool definition. */
export interface SharedMetaToolDefinition {
  /** Wire tool name, e.g. "codespar_invoice". */
  name: string;
  /** Description shown to the agent. */
  description: string;
  /** The input schema the agent is shown. */
  input_schema: MetaToolInputSchema;
  /** The conformance surface (property + required names). */
  contract: MetaToolConformanceContract;
}

/**
 * Derive the conformance contract from an input schema, so the property and
 * required sets never drift from the schema they describe.
 */
function contractOf(schema: MetaToolInputSchema): MetaToolConformanceContract {
  return {
    properties: Object.keys(schema.properties),
    required: [...(schema.required ?? [])],
  };
}

const INVOICE_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "What to do: issue (emit a new document — the default), status (read an existing document's fiscal state), or amend (correct an existing document). Defaults to issue, so existing issue-only callers are unaffected.",
    },
    type: { type: "string", description: "Invoice type: nfe, nfse, invoice" },
    recipient: { type: "object", description: "Recipient details (name, document, email). Required for action=issue." },
    items: { type: "array", description: "Line items. Required for action=issue." },
    dueDate: { type: "string", description: "Due date (ISO 8601)" },
    invoice_id: { type: "string", description: "The existing document's id to read or amend (action=status, action=amend)" },
    correction: { type: "string", description: "Correction text for an in-window correction letter (CC-e) amendment (action=amend)" },
    reason: { type: "string", description: "Why the document is being amended — drives correction-letter vs cancel-and-reissue (action=amend)" },
  },
  // `type` is required across all actions; recipient/items are issue-only and
  // the status/amend actions reference an existing document by id, so they are
  // not part of the shared required set. Issue callers still supply them.
  // `action` is OPTIONAL here (defaults to issue), so existing issue-only
  // callers are genuinely unaffected — unlike codespar_pay, which has no field
  // common to both actions and therefore makes `action` required.
  required: ["type"],
};

const NOTIFY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Notification channel: whatsapp, email, sms" },
    to: { type: "string", description: "Recipient phone number or email" },
    template: { type: "string", description: "Message template name" },
    message: { type: "string", description: "Custom message text" },
    variables: { type: "object", description: "Template variables" },
  },
  required: ["channel", "to"],
};

const PAY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "What to do: pay (execute a payment/transfer) or status (read an existing payment/charge/boleto's current status by id). Required — pass it explicitly on every call.",
    },
    amount: { type: "number", description: "Amount to pay, in minor units (centavos for BRL). Required for action=pay." },
    currency: { type: "string", description: "Currency code (BRL, USD, EUR). Required for action=pay." },
    country: { type: "string", description: "ISO-3166-1 alpha-2 country code for the eligibility rail" },
    method: { type: "string", description: "Payment method: pix, card, usdc, boleto, sepa, wire" },
    recipient: { type: "string", description: "Recipient identifier (e.g. a Pix key)" },
    copia_e_cola: { type: "string", description: "A Pix copia-e-cola / BR Code to pay" },
    consumer_id: { type: "string", description: "Which buyer's governed wallet pays" },
    checkout_session_id: { type: "string", description: "A store checkout session to settle" },
    description: { type: "string", description: "Payment description. Required for action=pay." },
    mandateId: { type: "string", description: "Pre-authorized mandate id" },
    payment_id: { type: "string", description: "The payment/charge/boleto id to read (action=status); status returns the provider status, e.g. OVERDUE for an expired/unpaid boleto" },
  },
  // `action` is the only field required across both actions: a pay call needs
  // amount/currency/description, a status call needs payment_id, so those are
  // per-action (described above), not part of the shared required set. Making
  // `action` required (rather than defaulted) matches codespar_kyc's required
  // discriminator and keeps the destructive `pay` from being the implicit
  // fallback of an under-specified call. NOTE: requiring `action` means a
  // pre-existing action-less caller must now pass it — a deliberate, small
  // contract change, NOT backward-compatible the way codespar_invoice's
  // optional `action` is (see INVOICE_INPUT). The flat schema cannot express
  // "amount required only when action=pay"; that per-action guard is enforced
  // by the runtime + governance rails below the tool, not here.
  required: ["action"],
};

/** Issue, read, or amend invoices and fiscal documents (NF-e / NFS-e / invoice). */
export const INVOICE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_invoice",
  description:
    "Issue, read, or amend invoices and Brazilian fiscal documents (NF-e, NFS-e). action=issue emits a new document (default); action=status reads an existing document's fiscal state (autorizada / cancelada / ...); action=amend corrects an existing document — a correction letter (CC-e) in place while the SEFAZ amendment window is open, or a cancel and reissue as a substitute once it is not (the result indicates which mechanism applied).",
  input_schema: INVOICE_INPUT,
  contract: contractOf(INVOICE_INPUT),
};

/** Send a notification over a messaging channel (WhatsApp / email / SMS). */
export const NOTIFY_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_notify",
  description:
    "Send a notification via WhatsApp, email, or SMS, using a template or custom message text.",
  input_schema: NOTIFY_INPUT,
  contract: contractOf(NOTIFY_INPUT),
};

/** Execute a governed payment or transfer (Pix / card / boleto / wire). */
export const PAY_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_pay",
  description:
    "Execute a payment or transfer, or read a payment's status. Pass action on every call. action=pay executes a payment/transfer under governance — Pix, card, USDC, boleto, SEPA, wire; can pay a Pix copia-e-cola or settle a store checkout. action=status reads an existing payment/charge/boleto's current status by id (e.g. OVERDUE for an expired/unpaid boleto), so an agent can discover post-purchase state before deciding what to do next.",
  input_schema: PAY_INPUT,
  contract: contractOf(PAY_INPUT),
};

/** The shared agent-facing definitions, keyed by wire tool name. */
export const SHARED_META_TOOL_DEFINITIONS = {
  codespar_invoice: INVOICE_DEFINITION,
  codespar_notify: NOTIFY_DEFINITION,
  codespar_pay: PAY_DEFINITION,
} as const;

/** Wire names that have a published shared definition. */
export type SharedMetaToolName = keyof typeof SHARED_META_TOOL_DEFINITIONS;
