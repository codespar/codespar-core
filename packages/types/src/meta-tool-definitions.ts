/* ── Shared meta-tool definitions ────────────────────────────────
 *
 * The agent-facing definition of a commerce meta-tool — its name, its
 * description, and the input schema the language model is shown — published
 * once here so every runtime presents the identical tool to the agent.
 *
 * A runtime registers an implementation behind a definition (the OSS runtime
 * via a `MetaToolHook`, a managed runtime via its built-in routing); the
 * implementations differ, but the definition the agent reasons over does not.
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
 * so two runtimes prove they present the same agent-facing tool.
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
  // Only `type` is required across all actions; recipient/items are issue-only
  // and the status/amend actions reference an existing document by id, so they
  // are not part of the shared required set. Issue callers still supply them.
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

const PAYMENT_STATUS_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    payment_id: {
      type: "string",
      description:
        "The payment/charge/boleto id to query (e.g. a charge id returned by codespar_pay or codespar_charge)",
    },
  },
  required: ["payment_id"],
};

const PAY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    amount: { type: "number", description: "Amount to pay, in minor units (centavos for BRL)" },
    currency: { type: "string", description: "Currency code (BRL, USD, EUR)" },
    country: { type: "string", description: "ISO-3166-1 alpha-2 country code for the eligibility rail" },
    method: { type: "string", description: "Payment method: pix, card, usdc, boleto, sepa, wire" },
    recipient: { type: "string", description: "Recipient identifier (e.g. a Pix key)" },
    copia_e_cola: { type: "string", description: "A Pix copia-e-cola / BR Code to pay" },
    consumer_id: { type: "string", description: "Which buyer's governed wallet pays" },
    checkout_session_id: { type: "string", description: "A store checkout session to settle" },
    description: { type: "string", description: "Payment description" },
    mandateId: { type: "string", description: "Pre-authorized mandate id" },
  },
  required: ["amount", "currency", "description"],
};

/** Issue, read, or amend invoices and fiscal documents (NF-e / NFS-e / invoice). */
export const INVOICE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_invoice",
  description:
    "Issue, read, or amend invoices and Brazilian fiscal documents (NF-e, NFS-e). action=issue emits a new document (default); action=status reads an existing document's fiscal state (autorizada / cancelada / ...); action=amend corrects an existing document — a correction letter (CC-e) in place while the SEFAZ amendment window is open, or a cancel and reissue as a substitute once it is not (the result indicates which mechanism applied).",
  input_schema: INVOICE_INPUT,
  contract: contractOf(INVOICE_INPUT),
};

/** Query a payment / charge / boleto's current status by id. */
export const PAYMENT_STATUS_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_payment_status",
  description:
    "Look up the current status of a payment, charge, or boleto by id. Returns the provider status (e.g. PENDING, RECEIVED, OVERDUE for an expired/unpaid boleto), so an agent can discover post-purchase state — like a boleto that expired unpaid — before deciding what to do next.",
  input_schema: PAYMENT_STATUS_INPUT,
  contract: contractOf(PAYMENT_STATUS_INPUT),
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
    "Execute a payment or transfer under governance. Supports Pix, card, USDC, boleto, SEPA, and wire; can pay a Pix copia-e-cola or settle a store checkout.",
  input_schema: PAY_INPUT,
  contract: contractOf(PAY_INPUT),
};

/** The shared agent-facing definitions, keyed by wire tool name. */
export const SHARED_META_TOOL_DEFINITIONS = {
  codespar_invoice: INVOICE_DEFINITION,
  codespar_notify: NOTIFY_DEFINITION,
  codespar_pay: PAY_DEFINITION,
  codespar_payment_status: PAYMENT_STATUS_DEFINITION,
} as const;

/** Wire names that have a published shared definition. */
export type SharedMetaToolName = keyof typeof SHARED_META_TOOL_DEFINITIONS;
