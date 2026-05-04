/* ── Runtime-agnostic session base ─────────────────────────────── */

export interface SessionBase {
  readonly id: string;
  readonly status: "active" | "closed" | "error";
  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  send(message: string): Promise<SendResult>;
  sendStream(message: string): AsyncIterable<StreamEvent>;
  connections(): Promise<BaseConnection[]>;
  close(): Promise<void>;
}

/* ── Codespar-specific session (extends base) ──────────────────── */

export interface Session extends SessionBase {
  proxyExecute(request: ProxyRequest): Promise<ProxyResult>;
  authorize(serverId: string, config: AuthConfig): Promise<AuthResult>;
  /**
   * Search the catalog for a tool that matches a free-form use case.
   * Typed wrapper around `execute("codespar_discover", {...})` — same
   * wire shape, returns `DiscoverResult` instead of generic ToolResult
   * so the agent doesn't have to cast.
   */
  discover(useCase: string, options?: DiscoverOptions): Promise<DiscoverResult>;
  /**
   * Surface the connection wizard for a server (or list every server's
   * status). Typed wrapper around
   * `execute("codespar_manage_connections", {...})`. Returns the
   * wizard payload directly — UI components like ConnectionWizardCard
   * render this without further parsing.
   */
  connectionWizard(
    options: ConnectionWizardOptions,
  ): Promise<ConnectionWizardResult>;
  /**
   * Create an INBOUND charge — the buyer pays the merchant. Typed
   * wrapper around `execute("codespar_charge", {...})`. Distinct from
   * the legacy `codespar_pay` rail, which routes to outbound
   * transfers / payouts. Routes to providers that issue charges
   * (Asaas create_payment, MP create_payment, Stripe payment_intent).
   *
   * `amount` is in MAJOR currency units (R$ 125.00 → 125). The
   * provider receives whatever shape it expects (Asaas + MP take
   * decimal major units; Stripe takes minor units — the backend
   * transform converts).
   */
  charge(args: ChargeArgs): Promise<ChargeResult>;
  /**
   * Async settlement check. After a meta-tool payment call returns,
   * the upstream provider eventually fires a webhook that lands in
   * `events`. This method correlates a tool_call back to the latest
   * known status (pending → succeeded / failed / refunded). Generic
   * across providers — relies on the `idempotency_key` propagated
   * upstream + the `external_reference` field on the normalized event
   * payload. Returns `unknown` when the tool_call has no
   * idempotency_key (legacy / non-meta-tool calls).
   */
  paymentStatus(toolCallId: string): Promise<PaymentStatusResult>;
  /**
   * SSE-streamed sibling of `paymentStatus`. Opens a long-lived
   * connection and invokes `onUpdate` whenever the backend pushes a
   * new envelope (initial snapshot + every state change). Resolves
   * when the backend closes the stream — typically 5s after a
   * terminal state (succeeded / failed / refunded). The optional
   * `signal` cancels the stream from the caller side; the backend
   * sees it as a normal client disconnect and tears its loop down.
   * Falls back to native `fetch` streaming; no extra deps. The
   * polling sibling (`paymentStatus`) stays live for backward compat.
   */
  paymentStatusStream(
    toolCallId: string,
    options: PaymentStatusStreamOptions,
  ): Promise<PaymentStatusResult>;
  /**
   * Async KYC poll. After a `codespar_kyc` call returns, the buyer
   * completes the hosted flow off-platform; provider webhooks (or
   * operator polling) update the verification state asynchronously.
   * This method correlates a tool_call back to the latest known
   * disposition (pending → approved / rejected / review / expired).
   * Generic across providers — same idempotency_key ↔
   * external_reference correlation as `paymentStatus`. Returns
   * `unknown` when the tool_call has no idempotency_key (legacy /
   * non-meta-tool calls).
   */
  verificationStatus(toolCallId: string): Promise<VerificationStatusResult>;
  /**
   * SSE-streamed sibling of `verificationStatus`. Same lifecycle as
   * `paymentStatusStream`: snapshot on open, an update per state
   * change, auto-close 5s after a terminal disposition (approved /
   * rejected / expired). `signal` aborts from the caller side.
   * Polling sibling (`verificationStatus`) stays live.
   */
  verificationStatusStream(
    toolCallId: string,
    options: VerificationStatusStreamOptions,
  ): Promise<VerificationStatusResult>;
  /**
   * Generate a shipping label OR fetch tracking status. Typed wrapper
   * around `execute("codespar_ship", {...})`. Routes to Melhor Envio
   * (BR domestic — Correios + private carriers) by default; international
   * carriers ship under a unified `{origin, destination, items}` envelope
   * as additional rails come online. The agent passes a neutral shape and
   * the router picks the cheapest carrier per request.
   */
  ship(args: ShipArgs): Promise<ShipResult>;
  mcp?: { url: string; headers: Record<string, string> };
}

/* ── codespar_charge wire shape ──────────────────────────────── */

/**
 * Inbound charge — the buyer pays the merchant. Mirrors the backend's
 * MetaChargeArgs (codespar-enterprise) so the wire payload matches
 * byte-for-byte. The discriminator vs `codespar_pay` (outbound) is
 * the `buyer` object: a charge always carries customer-facing buyer
 * details because the charge is owned by the merchant and presented
 * to the buyer.
 */
export interface ChargeBuyer {
  name: string;
  email?: string;
  document?: string;
  phone?: string;
}

export interface ChargeArgs {
  /** Amount in MAJOR currency units (R$ 125.00 → 125). */
  amount: number;
  /** ISO-4217 currency code (BRL, USD, EUR). */
  currency: string;
  /** Payment method: pix, boleto, card. */
  method: "pix" | "boleto" | "card";
  /** Charge description shown to the buyer. */
  description: string;
  /** Buyer details (always required — charges are merchant-issued). */
  buyer: ChargeBuyer;
  /** ISO 8601 due date (boleto / Pix expiration). */
  due_date?: string;
}

export interface ChargeResult {
  id: string;
  status: string;
  amount: number;
  currency: string;
  method: string;
  /** Hosted payment URL when the provider issues one (Asaas
   *  invoiceUrl, MP ticket_url, Stripe redirect). */
  charge_url?: string;
  pix_qr_code?: string;
  pix_copy_paste?: string;
  raw?: unknown;
}

/* ── codespar_ship wire shape ────────────────────────────────── */

/**
 * Shipping args. Three actions over a unified address+items envelope:
 *   - label  Generate a shipping label (issues a tracking code)
 *   - quote  Calculate carrier rates for a route + items
 *   - track  Fetch current tracking status for a shipment
 *
 * Mirrors the backend's MetaShipArgs (codespar-enterprise) so the wire
 * payload matches byte-for-byte. Operator overrides (Melhor Envio
 * service ids, NFe access keys for declared-value shipments) flow
 * through `metadata`.
 */
export interface ShipAddress {
  postal_code: string;
  city?: string;
  state?: string;
  country?: string;
  line_1?: string;
  number?: string;
}

export interface ShipItem {
  description?: string;
  weight_g: number;
  width_cm?: number;
  height_cm?: number;
  length_cm?: number;
  quantity?: number;
  declared_value?: number;
}

export interface ShipArgs {
  /** label | track | quote. */
  action: "label" | "track" | "quote";
  /** Sender address (required for action=label|quote). */
  origin?: ShipAddress;
  /** Recipient address (required for action=label|quote). */
  destination?: ShipAddress;
  /** Items to ship — each with weight_g + dimensions. Required for
   *  action=label|quote. */
  items?: ShipItem[];
  /** fastest | cheapest | standard. Default: cheapest. */
  service_level?: "fastest" | "cheapest" | "standard";
  /** Required for action=track. */
  tracking_code?: string;
  /** Provider-specific overrides (Melhor Envio service_id, NFe key for
   *  declared-value shipments, etc). */
  metadata?: Record<string, unknown>;
}

export interface ShipResult {
  id: string;
  status: string;
  tracking_code?: string;
  label_url?: string;
  carrier?: string;
  estimated_delivery?: string;
  cost_minor?: number;
  raw?: unknown;
}

/* ── /v1/tool-calls/:id/payment-status wire shape ──────────────── */

export type PaymentStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "refunded"
  | "updated"
  | "unknown";

export interface PaymentStatusEvent {
  event_type: string;
  received_at: string;
  provider: string | null;
  provider_action: string | null;
  payment_id: string | null;
}

export interface PaymentStatusResult {
  tool_call_id: string;
  payment_status: PaymentStatus;
  /** Null for legacy / non-meta-tool calls that didn't propagate a
   *  key upstream. */
  idempotency_key: string | null;
  /** The execute-time status (success/error). The asynchronous
   *  payment_status above is independent — a successful execute can
   *  still be pending settlement, and a settled payment can be later
   *  refunded. */
  original_status: string;
  events: PaymentStatusEvent[];
}

/** Options for `Session.paymentStatusStream`. The callback receives
 *  the SAME envelope shape as `paymentStatus()` returns — call sites
 *  can render incremental UI off the same parser they already wrote.
 *  The promise resolves with the LAST envelope seen, so callers that
 *  only care about the terminal disposition can `await` it without
 *  wiring `onUpdate`. */
export interface PaymentStatusStreamOptions {
  onUpdate?: (envelope: PaymentStatusResult) => void;
  signal?: AbortSignal;
}

/* ── /v1/tool-calls/:id/verification-status wire shape ─────────── */

/**
 * KYC polling analog of PaymentStatus. After `codespar_kyc` returns,
 * the buyer completes the hosted flow asynchronously (Persona inquiry,
 * Sift scoring, Konduto / Truora review). Webhooks normalize into
 * `commerce.kyc.*` events; this status is the latest known
 * disposition.
 *
 * Priority: approved > rejected > review > expired > pending > unknown.
 */
export type VerificationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "review"
  | "unknown";

export interface VerificationStatusEvent {
  event_type: string;
  received_at: string;
  provider: string | null;
  verification_id: string | null;
}

export interface VerificationStatusResult {
  tool_call_id: string;
  verification_status: VerificationStatus;
  /** Null for legacy / non-meta-tool calls that didn't propagate a
   *  key upstream. */
  idempotency_key: string | null;
  /** The execute-time status (success/error). The asynchronous
   *  verification_status above is independent — a successful execute
   *  only means the verification was created with the provider; the
   *  buyer still has to complete the hosted flow. */
  original_status: string;
  /** Buyer-facing verification URL (Persona inquiry, Truora link).
   *  Null for server-side scoring rails (Sift, Konduto risk-score)
   *  that have no hosted flow, or when the originating tool_call's
   *  output didn't surface the field. Best-effort — pulled from the
   *  call's stored output JSON. */
  hosted_url: string | null;
  events: VerificationStatusEvent[];
}

/** Options for `Session.verificationStatusStream`. Same shape as
 *  `PaymentStatusStreamOptions` — `onUpdate` receives the typed
 *  envelope on every state change; `signal` cancels the stream;
 *  the promise resolves with the last envelope observed. */
export interface VerificationStatusStreamOptions {
  onUpdate?: (envelope: VerificationStatusResult) => void;
  signal?: AbortSignal;
}

/* ── codespar_discover wire shape ───────────────────────────────── */

export interface DiscoverOptions {
  category?: string;
  country?: string;
  /** Max related results returned. Clamped 1..20 server-side. */
  limit?: number;
}

export interface DiscoverToolMatch {
  server_id: string;
  tool_name: string;
  description: string;
  http_method: string;
  endpoint_template: string;
  cosine_distance: number | null;
  trigram_similarity: number | null;
  connection_status: "connected" | "disconnected" | "not_required";
  known_pitfalls: string[];
  recommended_plan: DiscoverPlanStep[];
}

export interface DiscoverPlanStep {
  step: string;
  description?: string;
  prereq?: boolean;
  action?: boolean;
}

export interface DiscoverResult {
  use_case: string;
  /** Which path served the result. embedding > trigram in quality. */
  search_strategy: "embedding" | "trigram" | "empty";
  recommended: DiscoverToolMatch | null;
  related: DiscoverToolMatch[];
  next_steps: string[];
}

/* ── codespar_manage_connections wire shape ─────────────────────── */

export interface ConnectionWizardOptions {
  /** Defaults to "status" when server_id is given, else "list". */
  action?: "list" | "status" | "initiate";
  server_id?: string;
  country?: string;
  environment?: "live" | "test";
  /** Path inside the dashboard to redirect to after the user finishes
   *  connecting (initiate only). Validated to /dashboard/* on the
   *  dashboard side. */
  return_to?: string;
}

export interface ConnectionStatusRow {
  server_id: string;
  display_name: string;
  auth_type: string;
  status: "connected" | "disconnected" | "not_required" | "expired";
  difficulty: "easy" | "medium" | "hard";
  connection_metadata: Record<string, unknown>;
  connected_at: string | null;
}

export interface ConnectionWizardInstructions {
  server_id: string;
  display_name: string;
  auth_type: string;
  difficulty: "easy" | "medium" | "hard";
  status: ConnectionStatusRow["status"];
  connect_url: string;
  instructions: string[];
  required_secrets: Array<{ name: string; hint?: string }>;
  known_pitfalls: string[];
  next_action: string;
}

export interface ConnectionWizardResult {
  action: "list" | "status" | "initiate";
  /** Populated for action=list. */
  connections: ConnectionStatusRow[];
  /** Populated for action=status. */
  status: ConnectionStatusRow | null;
  /** Populated for action=initiate. */
  initiate: ConnectionWizardInstructions | null;
}

/* ── Connections ───────────────────────────────────────────────── */

export type BaseConnection = { id: string; connected: boolean };

export interface ServerConnection {
  id: string;
  name: string;
  category: string;
  country: string;
  auth_type: "oauth" | "api_key" | "cert" | "none";
  connected: boolean;
}

/* ── Session creation ─────────────────────────────────────────── */

export interface CreateSessionRequest {
  servers: string[];
  metadata?: Record<string, string>;
  projectId?: string;
}

/* ── Tool execution ─────────────────────────────────────────────── */

export interface ToolResult {
  success: boolean;
  data: unknown;
  error: string | null;
  duration: number;
  server: string;
  tool: string;
  tool_call_id?: string;
  called_at?: string;
}

/* ── Natural language send ──────────────────────────────────────── */

export interface SendResult {
  message: string;
  tool_calls: ToolCallRecord[];
  iterations: number;
}

export interface ToolCallRecord {
  id: string;
  tool_name: string;
  server_id: string;
  status: "success" | "error";
  duration_ms: number;
  input: unknown;
  output: unknown;
  error_code: string | null;
}

/* ── Streaming events (sendStream) ─────────────────────────────── */

export type StreamEvent =
  | { type: "user_message"; content: string }
  | { type: "assistant_text"; content: string; iteration: number }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCall: ToolCallRecord }
  | { type: "done"; result: SendResult }
  | { type: "error"; error: string; message?: string };

/* ── Proxy (raw HTTP passthrough) ───────────────────────────────── */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ProxyRequest {
  server: string;
  endpoint: string;
  method: HttpMethod;
  body?: unknown;
  params?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export interface ProxyResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
  duration: number;
  proxy_call_id?: string;
}

/* ── Auth ─────────────────────────────────────────────────────── */

export interface AuthConfig {
  redirectUri: string;
  scopes?: string;
}

export interface AuthResult {
  linkToken: string;
  authorizeUrl: string;
  expiresAt: string;
}
