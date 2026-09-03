/* ── Shared meta-tool definitions ────────────────────────────────
 *
 * The agent-facing definition of a commerce meta-tool — its name, its
 * description, and the input schema the language model is shown — published
 * once here so every runtime presents the identical tool to the agent.
 *
 * An implementation registers behind a definition (e.g. on the OSS runtime
 * via a `MetaToolHook`); implementations differ, but the definition the agent
 * reasons over does not.
 * The `contract` field carries the conformance surface — the property names,
 * the required subset, and the closed value vocabularies (`enums`) a
 * conforming implementation must expose — so a conformance test can assert
 * any runtime's tool matches this definition without comparing prose.
 *
 * Closed vocabularies (a rail list, an action set, a channel list) are
 * declared as structured `enum` arrays on the property, NEVER only in the
 * description prose. Prose-only vocabularies are exactly how the ent#933
 * triple drift happened: the published rails lived in a description string,
 * the structural conformance check deliberately skipped prose, and the
 * published contract silently advertised rails (sepa, usdc) that routed
 * nowhere while missing capabilities the runtime had. The checker in
 * `meta-tool-definition-conformance.ts` enforces that schema enums and
 * description prose agree, and that no retired rail is advertised anywhere.
 *
 * The definitions here are the SHARED BASELINE contract: a runtime may
 * publish additional, explicitly-allowlisted properties (and extend an
 * action vocabulary) for capabilities only it has — the managed runtime's
 * DICT claim lifecycle on codespar_pay is the canonical example (ent#932) —
 * but it may never drop a shared property, change a shared property's type,
 * or diverge on the required set.
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
  /**
   * Closed value vocabulary for this property. Declared structurally so a
   * conformance test can compare vocabularies without parsing prose — the
   * ent#933 fix. When present, every value must also appear in
   * `description`, so the agent-visible prose and the machine-checked
   * vocabulary cannot drift apart.
   */
  enum?: readonly string[];
  /**
   * Embedded object shape: the nested properties of an `object`-typed
   * input, when the contract pins them (e.g. codespar_crypto_pay's
   * `counterparty.country`). Published structurally for the same reason as
   * `enum` — an embedded form that lives only in prose is invisible to a
   * conformance test.
   */
  properties?: Record<string, MetaToolInputProperty>;
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
 * implementation must expose, the subset that is required, and the closed
 * value vocabularies. A conformance test compares a live runtime's tool
 * against this — structural, not prose — so an implementation can be checked
 * to present the same agent-facing tool as this shared definition.
 */
export interface MetaToolConformanceContract {
  /** Every property name the agent-facing tool exposes. */
  properties: readonly string[];
  /** The subset of `properties` that is required. */
  required: readonly string[];
  /**
   * Closed value vocabularies, keyed by property name — derived from the
   * schema's structured `enum` declarations. A conformance test reads the
   * vocabulary HERE (not from prose), so a rail or action published only in
   * a description string is a contract violation, not an invisible drift.
   */
  enums?: Readonly<Record<string, readonly string[]>>;
}

/** A shared, runtime-agnostic agent-facing meta-tool definition. */
export interface SharedMetaToolDefinition {
  /** Wire tool name, e.g. "codespar_invoice". */
  name: string;
  /** Description shown to the agent. */
  description: string;
  /** The input schema the agent is shown. */
  input_schema: MetaToolInputSchema;
  /** The conformance surface (property + required names + vocabularies). */
  contract: MetaToolConformanceContract;
}

/**
 * Derive the conformance contract from an input schema, so the property,
 * required, and vocabulary sets never drift from the schema they describe.
 */
export function contractOf(schema: MetaToolInputSchema): MetaToolConformanceContract {
  const enums: Record<string, readonly string[]> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    if (prop.enum) enums[name] = [...prop.enum];
  }
  return {
    properties: Object.keys(schema.properties),
    required: [...(schema.required ?? [])],
    ...(Object.keys(enums).length > 0 ? { enums } : {}),
  };
}

/* ── Input schemas ─────────────────────────────────────────────── */

const DISCOVER_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    use_case: { type: "string", description: "Free-form description of what you want to accomplish (e.g. 'send an email', 'create a Pix payment')" },
    category: { type: "string", description: "Optional category filter" },
    country: { type: "string", description: "ISO-3166-1 alpha-2 country code or '*' for any" },
    limit: { type: "number", description: "Max related tools returned (1..20, default 5)" },
  },
  required: ["use_case"],
};

// A no-argument tool: the schema is an empty object by design (the runtime
// derives everything from the authenticated session).
const GET_STARTED_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {},
};

const MANAGE_CONNECTIONS_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "list | status | initiate (dashboard providers) · connect_start | connect_finish (login-walled stores: meli, ifood) · save_profile | get_profile (vaulted shopper identity for guest-checkout stores)",
      enum: ["list", "status", "initiate", "connect_start", "connect_finish", "save_profile", "get_profile"],
    },
    server_id: { type: "string", description: "Provider/store id — required for status, initiate, connect_start, connect_finish (e.g. asaas, nfe-io, meli, ifood)" },
    country: { type: "string", description: "ISO-3166-1 alpha-2 filter (list only)" },
    environment: { type: "string", description: "live | test (default: live)", enum: ["live", "test"] },
    return_to: { type: "string", description: "Path inside the dashboard to redirect to after the user finishes connecting (initiate only)" },
    session_id: { type: "string", description: "From connect_start — pass it back to connect_finish (login-walled stores)" },
    context_id: { type: "string", description: "From connect_start — pass it back to connect_finish to persist the buyer's login (login-walled stores)" },
    consumer_id: { type: "string", description: "Which buyer is connecting / whose profile to save. Defaults to the session's user id." },
    profile: {
      type: "object",
      description:
        "The buyer's vaulted checkout identity (action=save_profile). Shape: { buyer: { firstName, lastName, email, document (CPF), phone }, address: { postalCode, street, number, neighborhood, city, state, complement } }. Stored encrypted; codespar_shop checkout auto-fills it.",
    },
  },
};

const CHECKOUT_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      description:
        "Items to purchase. Each item: { title?, price (major units, e.g. 125.5), quantity? (default 1) }. The total is the sum of price x quantity unless a top-level amount is passed.",
    },
    amount: {
      type: "number",
      description:
        "Optional explicit cart total in MAJOR currency units — wins over the items sum when provided.",
    },
    paymentMethod: {
      type: "string",
      description: "Payment method (rail): pix (default) | boleto | card. For usdc, call codespar_crypto_pay.",
      enum: ["pix", "boleto", "card"],
    },
    currency: { type: "string", description: "Currency code (default BRL)" },
    description: {
      type: "string",
      description: "Optional charge description shown to the shopper; defaults to a summary of the items.",
    },
    buyer: {
      type: "object",
      description:
        "Optional shopper details { name, email?, document?, phone? }; defaults to a guest checkout.",
    },
    metadata: {
      type: "object",
      description:
        "Optional provider metadata (e.g. customer_id for PSPs that require a pre-created customer).",
    },
    recipient: { type: "string", description: "Recipient identifier" },
  },
  required: ["items"],
};

const PAY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "pay (execute a payment/transfer) | status (read an existing payment/charge/boleto's status by id). Required — pass it explicitly on every call.",
      enum: ["pay", "status"],
    },
    amount: { type: "number", description: "Amount to pay, in minor units (centavos for BRL). Must match the copia-e-cola's amount when paying a QR. Required for action=pay." },
    currency: { type: "string", description: "Currency code (BRL, USD, EUR). Required for action=pay." },
    country: { type: "string", description: "ISO-3166-1 alpha-2 country code for the eligibility rail (BR, US, MX, AR, CL, CO, INTL). Defaults to BR. Set to US for cross-border USD card via ACP, INTL for hosted-checkout flows." },
    method: {
      type: "string",
      description:
        "Payment method: pix, card, boleto, wire. method=boleto pays/settles an EXISTING boleto (provide linha_digitavel); it does not issue new boleto charges. For USDC or any on-chain settlement use codespar_crypto_pay.",
      enum: ["pix", "card", "boleto", "wire"],
    },
    recipient: {
      type: "string",
      description:
        "EITHER a Pix KEY string (email, phone, CPF/CNPJ, EVP) — the common case — OR an object with bank-account details ({bank, account, branch, tax_id, name, account_type?}) to pay a destination that has no registered Pix key (Pix cash-out via initiationType MANUAL). Pass the object literally (do not JSON-stringify it) — the tool-call argument type, not this schema's declared string type, is what determines routing. For a copia-e-cola/QR use `copia_e_cola` instead.",
    },
    copia_e_cola: { type: "string", description: "A Pix copia-e-cola / BR Code to PAY (a store order's QR, '0002...'). Use this to pay a checkout's pix_copia_e_cola; the rail resolves the payee. Either recipient OR copia_e_cola is required." },
    consumer_id: { type: "string", description: "Whose governed wallet pays (the payment account to debit). Defaults to the session user — but for a checkout-originated Pix you MUST pass the consumer used in the checkout, otherwise the cash-out resolves no account. Same id as codespar_shop/codespar_wallet." },
    checkout_session_id: { type: "string", description: "To pay a codespar_shop checkout: pass its checkout_session_id and the backend resolves the EXACT Pix copia-e-cola server-side. PREFER THIS over copia_e_cola for a store order — never re-type the long Pix code yourself (re-typing corrupts the CRC). Pass with consumer_id." },
    description: { type: "string", description: "Payment description. Required for action=pay." },
    mandateId: { type: "string", description: "Pre-authorized mandate ID" },
    payment_id: { type: "string", description: "The payment/charge/boleto id to read (action=status); status returns the provider status, e.g. OVERDUE for an expired/unpaid boleto" },
    linha_digitavel: { type: "string", description: "The 47/48-digit linha digitavel (or barcode) of an existing boleto to pay (action=pay, method=boleto)" },
  },
  // `action` is the only field required across both actions: a pay call needs
  // amount/currency/description, a status call needs payment_id, so those are
  // per-action (described above), not part of the shared required set. Making
  // `action` required (rather than defaulted) matches codespar_kyc's required
  // discriminator and keeps the destructive `pay` from being the implicit
  // fallback of an under-specified call. The flat schema cannot express
  // "amount required only when action=pay"; that per-action guard is enforced
  // by the runtime + governance rails below the tool, not here.
  //
  // The method vocabulary is the ent#932 decision: pix, card, boleto, wire —
  // no sepa/usdc/ted. sepa and usdc have no route under this tool (usdc's
  // redirect target is codespar_crypto_pay) and ted is unpublished until the
  // public TED route ships. A rail without a route must not be published.
  //
  // The managed runtime extends this baseline with allowlisted extras
  // (boleto_quote, the DICT claim lifecycle, expected_amount_minor — ent#932);
  // those are managed-only capabilities, deliberately NOT part of the shared
  // contract the OSS runtime must implement.
  required: ["action"],
};

const WALLET_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "balance | statement | receive (default: balance)", enum: ["balance", "statement", "receive"] },
    consumer_id: { type: "string", description: "Whose wallet — defaults to the session user id" },
    amount: { type: "number", description: "Top-up amount in minor units (centavos for BRL) — action=receive" },
    description: { type: "string", description: "Charge description shown to the payer — action=receive" },
    dynamic: { type: "boolean", description: "action=receive: mint a DYNAMIC copia-e-cola (location URL) instead of a static QR. Default false (static)." },
    limit: { type: "number", description: "Max ledger entries (1..100, default 20) — action=statement" },
  },
  required: ["action"],
};

const SHOP_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "search | checkout | checkout_status (default: search)", enum: ["search", "checkout", "checkout_status"] },
    merchant: { type: "string", description: "Store slug: cobasi | animale | lojaspompeia (VTEX), meli (Mercado Livre)", enum: ["cobasi", "animale", "lojaspompeia", "meli"] },
    query: { type: "string", description: "What to search for (action=search), e.g. 'tv 55 4k'" },
    limit: { type: "number", description: "Max results returned, 1..20 (action=search)" },
    items: {
      type: "array",
      description: "Items to buy: [{ variant_id, quantity, seller? }] (action=checkout, VTEX stores)",
    },
    url: { type: "string", description: "Listing URL to buy (action=checkout, Mercado Livre — it has no buyer API)" },
    paymentMethod: { type: "string", description: "Settlement rail the store mints — pix (default)", enum: ["pix"] },
    consumer_id: { type: "string", description: "Which buyer is shopping — resolves their connected Mercado Livre login (action=checkout, meli)" },
    checkout_session_id: { type: "string", description: "From action=checkout — pass it to action=checkout_status to poll for the Pix" },
    auto_pay: { type: "boolean", description: "action=checkout_status ONLY: when the order is ready_for_payment, pay it AUTOMATICALLY server-side from the consumer's governed wallet (pass consumer_id) and return status='paid' + a payment receipt. The agent never handles the Pix code or calls codespar_pay — the backend does the payment within the consumer's mandate. Use this to complete a purchase in one shopping flow." },
    buyer: { type: "object", description: "Vaulted shopper profile (email, firstName, lastName, document, phone) — optional" },
    address: { type: "object", description: "Shipping address (postalCode, street, number, neighborhood, city, state, complement) — optional" },
  },
  required: ["action"],
};

const CHARGE_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    amount: { type: "number", description: "Charge amount in major currency unit (R$ 125.00 → 125)" },
    currency: { type: "string", description: "Currency code (BRL, USD, EUR)" },
    country: { type: "string", description: "ISO-3166-1 alpha-2 country code for the eligibility rail (BR, US, MX, AR, CL, CO, INTL). Defaults to BR. Set to US for cross-border USD card via ACP, INTL for hosted-checkout flows." },
    method: { type: "string", description: "Payment method: pix, boleto, card, wallet", enum: ["pix", "boleto", "card", "wallet"] },
    description: { type: "string", description: "Charge description shown to buyer" },
    buyer: {
      type: "object",
      description: "Buyer details (name, email, document, phone)",
    },
    due_date: { type: "string", description: "ISO 8601 due date (boleto only)" },
    metadata: { type: "object", description: "Provider-specific overrides" },
  },
  required: ["amount", "currency", "method", "description", "buyer"],
};

const INVOICE_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "issue (emit, default) | status (read fiscal state) | amend (correct in place via CC-e, or cancel + reissue as a substitute)",
      enum: ["issue", "status", "amend"],
    },
    type: { type: "string", description: "Invoice type: nfe, nfse, invoice", enum: ["nfe", "nfse", "invoice"] },
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

const SHIP_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "label | track | quote", enum: ["label", "track", "quote"] },
    origin: { type: "object", description: "Sender address (postal_code + city + state)" },
    destination: { type: "object", description: "Recipient address" },
    items: { type: "array", description: "Items to ship — each with weight_g + dimensions" },
    service_level: { type: "string", description: "fastest | cheapest | standard", enum: ["fastest", "cheapest", "standard"] },
    tracking_code: { type: "string", description: "For action=track only" },
    metadata: { type: "object", description: "Provider-specific overrides" },
  },
  required: ["action"],
};

const NOTIFY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    channel: { type: "string", description: "Notification channel: whatsapp, email, sms", enum: ["whatsapp", "email", "sms"] },
    to: { type: "string", description: "Recipient phone number or email" },
    template: { type: "string", description: "Message template name" },
    message: { type: "string", description: "Custom message text" },
    variables: { type: "object", description: "Template variables" },
  },
  required: ["channel", "to"],
};

const CRYPTO_PAY_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    amount: { type: "number", description: "Amount in target currency major unit" },
    currency: { type: "string", description: "Crypto currency code: USDC, USDT, BTC, ETH, MATIC", enum: ["USDC", "USDT", "BTC", "ETH", "MATIC"] },
    network: { type: "string", description: "Blockchain network: ethereum, polygon, base, solana, bitcoin", enum: ["ethereum", "polygon", "base", "solana", "bitcoin"] },
    direction: { type: "string", description: "send | receive", enum: ["send", "receive"] },
    counterparty: {
      type: "object",
      description:
        "Recipient (send) or buyer (receive). For `direction: send` counterparty is required and must include `country` (ISO 3166-1 alpha-2) so the router + audit log can track the destination of cross-border flows. For `direction: receive` counterparty is optional — the buyer is anonymous until they hit the hosted URL.",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code of the recipient (e.g. 'US', 'BR', 'MX'). Required when direction='send'." },
      },
    },
    metadata: { type: "object", description: "Provider-specific overrides" },
  },
  required: ["amount", "currency", "direction"],
};

const KYC_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    buyer: { type: "object", description: "Subject. For onboarding (PF): { fullName, document (CPF), email, phoneNumber (+55…; sandbox last digit 1 = auto-approve), birthDate (DD-MM-YYYY), motherName, address, country }. For onboarding-business (PJ/MEI): { document (CNPJ, 14 digits), businessName (razão social), tradingName?, businessEmail, contactNumber, businessAddress (or address), owner: [...] } — owner[] is required and its FIRST entry must be the sócio responsible for documentation (ownerType REPRESENTANTE, full PF data; their CPF is the documentoscopia target). For verification: { name, document, country, email }." },
    check_type: {
      type: "string",
      description:
        "identity | document | risk-score | sanctions | onboarding (open a BR payment account — natural person, CPF) | onboarding-business (open a BR payment account — legal person, CNPJ / PJ / MEI) | status (poll a verification_id)",
      enum: ["identity", "document", "risk-score", "sanctions", "onboarding", "onboarding-business", "status"],
    },
    verification_id: { type: "string", description: "From a prior call — REQUIRED with check_type=status to poll completion. It names the proposal that verified the document, and it is the only thing that provisions a payment account: a status poll without it never binds an account, because a document number an agent typed is not proof the document is the consumer's" },
    document_number: { type: "string", description: "CPF (or CNPJ when polling an onboarding-business proposal) — required with check_type=status (identifies the subject; NOT on its own a licence to bind that person's account). It must be the SAME document the verification_id's proposal verified — never used to look an account up: a mismatch refuses with onboarding_document_mismatch" },
    consumer_id: { type: "string", description: "Whose account/verification — defaults to the session user id (onboarding + status)" },
    metadata: { type: "object", description: "Provider-specific overrides" },
  },
  required: ["buyer", "check_type"],
};

const LEDGER_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "entry | balance | account | receipt | receipts (default: entry)", enum: ["entry", "balance", "account", "receipt", "receipts"] },
    receipt_id: { type: "string", description: "The agentic receipt id (rcpt_...) to read (action=receipt)." },
    consumer_id: { type: "string", description: "Whose receipts to list (action=receipts). Defaults to the session user." },
    limit: { type: "number", description: "Max receipts to list (action=receipts, default 50)." },
    asset: { type: "string", description: "Asset / currency code for entry + account (BRL, USD, ...)" },
    scale: { type: "number", description: "Decimal places for the asset (default 2; JPY=0, most crypto=6/8)" },
    source: { type: "array", description: "Debit side(s) of an entry: [{ account (alias), amount (minor units) }]" },
    destination: { type: "array", description: "Credit side(s) of an entry: [{ account (alias), amount (minor units) }]" },
    description: { type: "string", description: "Transaction description (entry only)" },
    account: { type: "string", description: "Account UUID to read balances for (action=balance)" },
    alias: { type: "string", description: "Account alias, e.g. @wallet/user_123 (action=account)" },
    name: { type: "string", description: "Account display name (action=account)" },
    type: { type: "string", description: "Ledger account type: deposit, savings, external (action=account, default deposit)", enum: ["deposit", "savings", "external"] },
    metadata: { type: "object", description: "Free-form metadata stored on the entry / account" },
  },
  required: ["action"],
};

const ISSUE_INPUT: MetaToolInputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "card-virtual | card-physical | card-control | card-get (default: card-virtual)", enum: ["card-virtual", "card-physical", "card-control", "card-get"] },
    cardholder_id: { type: "string", description: "Cardholder id at the issuer. Required to issue a card." },
    program_id: { type: "string", description: "Card program / BIN (issuer affinity group). Required to issue a card." },
    card_id: { type: "string", description: "Card id — required for card-control and card-get." },
    control: { type: "string", description: "freeze | unfreeze | cancel (card-control only)", enum: ["freeze", "unfreeze", "cancel"] },
    reason: { type: "string", description: "Reason stamped on a control action" },
    shipping_address: { type: "object", description: "Shipping address (card-physical only)" },
    metadata: { type: "object", description: "Provider-specific overrides" },
  },
  required: ["action"],
};

/* ── Definitions ───────────────────────────────────────────────── */

/** Find the right catalog tool (or native meta-tool) for a free-form use case. */
export const DISCOVER_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_discover",
  description:
    "Find the right tool for a free-form use case. Returns the recommended catalog tool (plus its connection status, known pitfalls, recommended plan, and related tools) AND, in `meta_tools`, any native CodeSpar high-level tools that cover the same job — e.g. 'buy a TV' surfaces codespar_shop, 'send a Pix' surfaces codespar_pay, 'save my address' surfaces codespar_manage_connections. Prefer a native meta-tool when one is returned. Use discover when you don't already know the canonical tool name to call.",
  input_schema: DISCOVER_INPUT,
  contract: contractOf(DISCOVER_INPUT),
};

/** Read-only happy-path plan for the authenticated workspace. */
export const GET_STARTED_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_get_started",
  description:
    "Get the recommended happy path for this authenticated CodeSpar workspace. Read-only and informational — it returns a structured, ordered plan (it does NOT execute a charge or move money). In the test environment the sandbox rails (Pix in/out, wallet) ship PRE-CONNECTED, so you can run the full flow with no bank connection, CNPJ, or KYC: drive codespar_shop -> codespar_wallet -> codespar_pay under a signed mandate, or use codespar_charge for a Pix in-collection (the buyer pays you). Call this first when a user asks 'how do I start / what can you do' so you can act without a discovery detour. (Named to match the MCP server's no-key setup tool: exactly one codespar_get_started is ever visible — the no-key setup tool mints a key, this authenticated tool hands you the happy path.)",
  input_schema: GET_STARTED_INPUT,
  contract: contractOf(GET_STARTED_INPUT),
};

/** List, inspect, or connect the accounts + identity the agent needs. */
export const MANAGE_CONNECTIONS_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_manage_connections",
  description:
    "List, inspect, or connect the accounts + identity the agent needs. For API-key/OAuth providers (server_id like asaas, nfe-io): action=list|status|initiate surfaces a dashboard connect deep-link — NEVER pass credentials here (they travel via the dashboard or OAuth callback). For login-walled STORES that have no buyer API (server_id=meli or ifood): action=connect_start returns a live-view URL the user opens to log into their OWN account once (their 2FA); then action=connect_finish (with the session_id + context_id from connect_start) persists that login. For meli, the connected login is what codespar_shop buys with on the buyer's own account. iFood checkout is not supported yet: connecting an iFood login only stores the session for a future capability — codespar_shop CANNOT buy on iFood today, so tell the user that BEFORE asking them to log in. For GUEST-checkout stores (VTEX: cobasi/animale/…) the buyer has no login but checkout still needs their data — action=save_profile vaults the buyer's checkout identity ONCE (name, email, CPF, full address; encrypted) so codespar_shop auto-fills it; action=get_profile returns it masked. ALWAYS ASK the buyer which email to use at checkout — do NOT infer it: it's where the order confirmation goes, and an email that already has an account at the store forces a VTEX ID login/identity wall the agent can't pass, so use a dedicated checkout email NOT registered at the store (keeps checkout as guest). save_profile merges field-by-field, so you can save the address first and add the email later; the response returns needs:'email' + profile_complete:false until an email is set. Saving the profile once means later purchases don't re-ask for CEP/email/CPF.",
  input_schema: MANAGE_CONNECTIONS_INPUT,
  contract: contractOf(MANAGE_CONNECTIONS_INPUT),
};

/** SELL-side merchant checkout: assemble a cart and create a payment for a shopper. */
export const CHECKOUT_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_checkout",
  description:
    "SELL-side merchant checkout: as a MERCHANT, assemble a cart and create a payment for a shopper to pay YOU. Sums items into a total, dispatches it as an inbound charge on the tenant's connected payment rails, and returns the charge with a hosted payment page (charge_url) plus, on the Pix rail, the pix_copy_paste code. paymentMethod picks the rail: pix (live, BRL default), boleto/card (per catalog); for usdc use codespar_crypto_pay. Distinct from codespar_shop, the buy-side tool where the agent IS the shopper spending its own wallet.",
  input_schema: CHECKOUT_INPUT,
  contract: contractOf(CHECKOUT_INPUT),
};

/** Execute a governed payment or transfer, or read a payment's status. */
export const PAY_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_pay",
  description:
    "Execute a direct payment or transfer, or read a payment's status. Pass action on every call. action=pay executes a payment/transfer with full governance (policy + mandate + routing) — Pix, card, boleto, wire (for USDC or any on-chain settlement use codespar_crypto_pay). To PAY a store order's Pix copia-e-cola / QR (what codespar_shop checkout returns as pix_copia_e_cola), pass it as `copia_e_cola` — NOT as `recipient`; the rail decodes the QR (static or dynamic) and debits the governed wallet. A Pix cash-out is async: the result has `settled` + `status_message` — status=PROCESSING means ACCEPTED and settling (seconds), NOT failed, and the wallet is already debited. Relay `status_message` to the user, don't surface a bare PROCESSING. To pay an existing boleto, pass method=boleto with linha_digitavel (the boleto's 47/48-digit code or barcode); this settles an EXISTING boleto, it does not issue new boleto charges. action=status reads an existing payment/charge/boleto's current status by id (e.g. OVERDUE for an expired/unpaid boleto), so an agent can discover post-purchase state before deciding what to do next.",
  input_schema: PAY_INPUT,
  contract: contractOf(PAY_INPUT),
};

/** Programmable wallet for the agent/consumer's governed funds. */
export const WALLET_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_wallet",
  description:
    "Programmable wallet for the agent/consumer's governed funds. action=balance returns the wallet balance + Pix key (the spendable funds); action=statement returns the wallet ledger (funds, holds, debits, newest first); action=receive mints a Pix copia-e-cola — a QR a payer pays to TOP UP the wallet (settling credits the wallet via the inbound webhook). Scoped to the consumer (consumer_id defaults to the session user). Distinct from codespar_ledger (the double-entry books) and codespar_pay (spending OUT). Use receive to fund, then codespar_pay to spend.",
  input_schema: WALLET_INPUT,
  contract: contractOf(WALLET_INPUT),
};

/** BUY-side shopping: search a store's live catalog and buy with a real Pix checkout. */
export const SHOP_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_shop",
  description:
    "USE THIS TOOL for ANY request to find, search, browse, compare, or buy products at a supported Brazilian store — Cobasi, Animale, Lojas Pompeia, or Mercado Livre. It returns the store's LIVE, in-stock, actually-BUYABLE catalog (rendered as product cards) with a real Pix checkout — prefer it over a generic web search for these stores, which only returns links you can't buy from. BUY-side shopping: act as the SHOPPER. Search a store's catalog and buy a product, minting the store's REAL Pix copia-e-cola to settle from your governed wallet (codespar_pay × pix). action=search returns card-ready offers for a merchant query — each with product_id, sku_id (USE THIS as the checkout variant_id, NOT product_id), title, price, image, and variants (size options, each its own sku_id). action=checkout STARTS the store's real checkout — a ~1-2 min browser flow (VTEX guest checkout today: Cobasi, Animale, Lojas Pompeia; Mercado Livre via the buyer's connected login) — and returns IMMEDIATELY with { checkout_session_id, status:'in_progress' }; do NOT block. Then poll action=checkout_status with that checkout_session_id every ~15s until status='ready_for_payment', which returns the payable pix_copia_e_cola + total. A status='canceled' carries a structured reason: retriable=true (reason_code 'store_temporarily_unavailable' / 'checkout_failed') is a TEMPORARY store/session fault — re-call action=checkout to retry; it is NOT an out-of-stock. Only reason_code='no_shipping' is a genuine no-delivery/out-of-stock (offer alternatives then). reason_code='identity_required' → the store demands a login the agent can't pass; reason_hint says whether a fresh guest email can work or the store requires login for EVERY purchase (then do NOT retry — no email helps); 'not_connected' → connect the account first. Relay reason_hint to the user. This async checkout-session model is protocol-agnostic (ACP-aligned). Use when the AGENT is the buyer spending money. Distinct from codespar_checkout, the SELL-side merchant primitive.",
  input_schema: SHOP_INPUT,
  contract: contractOf(SHOP_INPUT),
};

/** Create an INBOUND charge — the buyer pays the merchant. */
export const CHARGE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_charge",
  description:
    "Create an INBOUND charge — the buyer pays the merchant. Pix charge / boleto / hosted card checkout / digital wallet redirect. Distinct from codespar_pay (outbound transfer/payout). Routes to the tenant's connected charge-issuing providers.",
  input_schema: CHARGE_INPUT,
  contract: contractOf(CHARGE_INPUT),
};

/** Issue, read, or amend invoices and fiscal documents (NF-e / NFS-e / invoice). */
export const INVOICE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_invoice",
  description:
    "Issue, read, or amend invoices, NF-e (Nota Fiscal Eletrônica), or NFS-e. action=issue emits a new document (default); action=status reads an existing document's fiscal state (autorizada / cancelada / ...); action=amend corrects an existing document — a correction letter (CC-e) in place while the SEFAZ amendment window is open, or a cancel and reissue as a substitute (tipo 3) once it is not, with the result indicating which mechanism applied.",
  input_schema: INVOICE_INPUT,
  contract: contractOf(INVOICE_INPUT),
};

/** Generate a shipping label, fetch tracking status, or quote carriers. */
export const SHIP_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_ship",
  description:
    "Generate a shipping label OR fetch tracking status. Routes BR domestic (Correios + private carriers) or international carriers via a unified shape: the agent passes a neutral {origin, destination, items} shape and the router picks the cheapest carrier per request.",
  input_schema: SHIP_INPUT,
  contract: contractOf(SHIP_INPUT),
};

/** Send a notification over a messaging channel (WhatsApp / email / SMS). */
export const NOTIFY_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_notify",
  description:
    "Send a notification via WhatsApp, email, or SMS, using a template or custom message text.",
  input_schema: NOTIFY_INPUT,
  contract: contractOf(NOTIFY_INPUT),
};

/** Send or receive a crypto payment (USDC/USDT/BTC across mainnet + L2s). */
export const CRYPTO_PAY_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_crypto_pay",
  description:
    "Send or receive a crypto payment. USDC/USDT/BTC across mainnet + L2s. Routes to hosted-checkout, exchange, on/offramp, or x402 micropayment rails. Distinct from codespar_pay (fiat rails).",
  input_schema: CRYPTO_PAY_INPUT,
  contract: contractOf(CRYPTO_PAY_INPUT),
};

/** Run a KYC / identity verification, or open a payments account. */
export const KYC_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_kyc",
  description:
    "Run a KYC / identity verification, OR open a payments account. check_type=identity|document runs an identity/document verification; risk-score returns a fraud risk score; sanctions runs a sanctions screening. check_type=onboarding (BR, natural person / CPF) and check_type=onboarding-business (BR, legal person / CNPJ — PJ/MEI) route to a licensed BaaS partner and are special: they VERIFY (background check + documentoscopia) AND PROVISION a real payment account for the consumer — that account becomes the codespar_wallet funding source (so after onboarding, codespar_wallet balance/receive and codespar_pay work for the same consumer_id). For onboarding-business the documentoscopia target is the responsible partner (buyer.owner[0]), not the company itself. Every check_type returns a verification_id; poll completion with check_type=status (pass verification_id + document_number — the verification_id is required, a status poll with only a document number provisions nothing and refuses with document_ownership_unproven). For onboarding, status returns 'pending' | 'documentscopy_pending' (with a hosted_url to finish doc capture) | 'approved' (with the funding source) | 'rejected'. Sandbox: a phoneNumber ending in 1 auto-approves both gates.",
  input_schema: KYC_INPUT,
  contract: contractOf(KYC_INPUT),
};

/** Double-entry ledger: post entries, read balances, create accounts, read receipts. */
export const LEDGER_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_ledger",
  description:
    "Record money movement in a double-entry ledger, read account balances, create accounts, or read the agentic receipt of a spend. Routes to the tenant's self-hosted ledger instance (multi-currency, multi-asset, immutable + auditable). action=entry posts an n:n journal entry (source debits must equal destination credits); action=balance reads an account's balances; action=account creates an account. action=receipt returns the canonical agentic receipt (the Control Record: mandate -> quote -> payment -> delivery, with a tamper-evident chain hash + any settle-time exceptions) by receipt_id; action=receipts lists a consumer's receipts (newest first). Amounts are in minor units. The ledger is asset-agnostic — no currency/country needed. Distinct from codespar_pay/charge (those move real money via PSPs); this is the system of record / books.",
  input_schema: LEDGER_INPUT,
  contract: contractOf(LEDGER_INPUT),
};

/** Issue and control payment cards for AI agents or end-users. */
export const ISSUE_DEFINITION: SharedMetaToolDefinition = {
  name: "codespar_issue",
  description:
    "Issue and control payment cards for AI agents or end-users. Routes to a card-issuing partner (pan-LATAM issuing-as-a-service). action=card-virtual issues a virtual card (active immediately); card-physical issues a physical card (needs shipping_address); card-control freezes/unfreezes/cancels an existing card; card-get reads a card's status. This is the agent-spend-card primitive — it creates SPEND INSTRUMENTS, distinct from codespar_pay/charge which move money.",
  input_schema: ISSUE_INPUT,
  contract: contractOf(ISSUE_INPUT),
};

/**
 * The shared agent-facing definitions, keyed by wire tool name — the FULL
 * meta-tool surface, all fifteen tools. (This used to publish only the three
 * demo tools — invoice/notify/pay — leaving twelve agent-facing tools,
 * codespar_wallet and codespar_kyc among them, with no published definition
 * at all; ent#933.)
 */
export const SHARED_META_TOOL_DEFINITIONS = {
  codespar_discover: DISCOVER_DEFINITION,
  codespar_get_started: GET_STARTED_DEFINITION,
  codespar_manage_connections: MANAGE_CONNECTIONS_DEFINITION,
  codespar_checkout: CHECKOUT_DEFINITION,
  codespar_pay: PAY_DEFINITION,
  codespar_wallet: WALLET_DEFINITION,
  codespar_shop: SHOP_DEFINITION,
  codespar_charge: CHARGE_DEFINITION,
  codespar_invoice: INVOICE_DEFINITION,
  codespar_ship: SHIP_DEFINITION,
  codespar_notify: NOTIFY_DEFINITION,
  codespar_crypto_pay: CRYPTO_PAY_DEFINITION,
  codespar_kyc: KYC_DEFINITION,
  codespar_ledger: LEDGER_DEFINITION,
  codespar_issue: ISSUE_DEFINITION,
} as const;

/** Wire names that have a published shared definition. */
export type SharedMetaToolName = keyof typeof SHARED_META_TOOL_DEFINITIONS;
