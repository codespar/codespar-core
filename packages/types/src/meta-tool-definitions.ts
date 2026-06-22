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
    type: { type: "string", description: "Invoice type: nfe, nfse, invoice" },
    recipient: { type: "object", description: "Recipient details (name, document, email)" },
    items: { type: "array", description: "Line items" },
    dueDate: { type: "string", description: "Due date (ISO 8601)" },
  },
  required: ["type", "recipient", "items"],
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

/** Issue invoices and fiscal documents (NF-e / NFS-e / invoice). */
export const INVOICE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_invoice",
  description:
    "Issue invoices or Brazilian fiscal documents (NF-e, NFS-e). Selects the document type and recipient and emits the document.",
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
    "Execute a payment or transfer under governance. Supports Pix, card, USDC, boleto, SEPA, and wire; can pay a Pix copia-e-cola or settle a store checkout.",
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
