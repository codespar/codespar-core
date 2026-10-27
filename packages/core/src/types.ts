import { z } from "zod";
import type { CallOptions, MockValue, ToolResult } from "@codespar/types";

// CallOptions is the shared client-side option bag. Single source of
// truth lives in @codespar/types so the public Session contract and
// the core runtime can never drift.
export type { CallOptions } from "@codespar/types";

/* ── Configuration ─────────────────────────────────────────────── */

export interface CodeSparConfig {
  /** API key for managed mode. Obtain from dashboard.codespar.dev */
  apiKey?: string;
  /** Base URL for CodeSpar API. Defaults to https://api.codespar.dev */
  baseUrl?: string;
  /** Optional project scope. Defaults to the org's default project when omitted. */
  projectId?: string;
  /** Default per-request timeout in ms. Default 60000. */
  timeout?: number;
}

/* ── Session config (SDK-level, not the wire contract) ──────────── */

export interface SessionConfig {
  /** MCP servers to connect, by id (e.g. "zoop", "nuvem-fiscal") */
  servers?: string[];
  /** Preset configurations. "brazilian" enables BR commerce servers. */
  preset?: "brazilian" | "mexican" | "argentinian" | "colombian" | "all";
  /** Connection management options */
  manageConnections?: {
    /** Block until all servers are connected */
    waitForConnections?: boolean;
    /** Timeout in ms for connection wait. Default: 30000 */
    timeout?: number;
  };
  /** Metadata attached to every tool call in this session */
  metadata?: Record<string, string>;
  /** Optional project scope. Defaults to the org's default project when omitted. */
  projectId?: string;
  /**
   * Test-mode mocks. Map of canonical tool names (slash form,
   * `^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*$` — e.g.
   * `asaas/create_payment`) to mock responses. Values are either a
   * single MockObject (static mock) or an array of MockObject
   * (stateful mock, consumed in order).
   *
   * Requires a `csk_test_*` key against a `test`-environment project
   * — the backend rejects with `mocks_not_permitted` otherwise.
   * Forwarded verbatim to `POST /v1/sessions` so the OSS-runtime
   * double-underscore form (`asaas__create_payment`) reaches the
   * backend unrewritten and surfaces as `mocks_invalid`. An empty
   * `{}` is accepted; strict-mode (R3a) activates only on non-empty
   * maps.
   */
  mocks?: Record<string, MockValue>;
}

/* ── Tools ────────────────────────────────────────────────────── */

export interface Tool {
  /** Tool name (e.g. "codespar_pay") */
  name: string;
  /** Human-readable description shown to LLMs */
  description: string;
  /** JSON Schema for tool inputs */
  input_schema: Record<string, unknown>;
  /** Server that provides this tool (for routing/billing). May be "codespar" for meta-tools. */
  server: string;
}

/* ── Complete Loop ────────────────────────────────────────────── */

export interface LoopStep {
  /** Tool name to execute */
  tool: string;
  /** Tool parameters */
  params: Record<string, unknown> | ((prevResults: ToolResult[]) => Record<string, unknown>);
  /** Optional: skip this step if condition returns false */
  when?: (prevResults: ToolResult[]) => boolean;
}

export interface LoopConfig {
  /** Steps to execute in order */
  steps: LoopStep[];
  /** Called after each step completes */
  onStepComplete?: (step: LoopStep, result: ToolResult, index: number) => void;
  /** Called if a step fails */
  onStepError?: (step: LoopStep, error: Error, index: number) => void;
  /** Retry policy for failed steps */
  retryPolicy?: {
    maxRetries?: number;
    backoff?: "linear" | "exponential";
    baseDelay?: number;
  };
  /** Abort all remaining steps on first failure. Default: true */
  abortOnError?: boolean;
}

export interface LoopResult {
  success: boolean;
  /** Results from each step, in order */
  results: ToolResult[];
  /** Total execution time in ms */
  duration: number;
  /** Number of steps completed */
  completedSteps: number;
  /** Total steps attempted */
  totalSteps: number;
}

/* ── Validation schemas ───────────────────────────────────────── */

// Mock values pass through verbatim — the backend owns the strict
// validation, so the client-side schema accepts any object shape
// rather than re-encoding the rules and risking drift.
const MockValueSchema = z.union([
  z.record(z.unknown()),
  z.array(z.record(z.unknown())),
]);

/** Wire format for a project scope. Shared by the Zod session schema
 *  and the client constructor so both validation paths stay in sync. */
export const PROJECT_ID_REGEX = /^prj_[A-Za-z0-9]{16}$/;

export const SessionConfigSchema = z.object({
  servers: z.array(z.string()).optional(),
  preset: z.enum(["brazilian", "mexican", "argentinian", "colombian", "all"]).optional(),
  manageConnections: z
    .object({
      waitForConnections: z.boolean().optional(),
      timeout: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string()).optional(),
  projectId: z.string().regex(PROJECT_ID_REGEX).optional(),
  mocks: z.record(MockValueSchema).optional(),
});

/* ── Payables: documents and batches (/v1/payables/files, /v1/payables/batches) ── */

/** A file read by `POST /v1/payables/files`. The original is not kept, only its digest and what was found in it. */
export interface PayableFile {
  file_id: string;
  kind: "pdf" | "image" | "csv" | "xlsx";
  sha256: string;
  size_bytes: number;
  /** Charges found in the file. */
  items_found: number;
  /** Of those, how many still need a complement in the review. */
  unresolved: number;
  /** A file no batch uses expires 24 h after the upload. */
  expires_at: string;
}

export type PayableBatchStatus =
  | "reviewing"
  | "ready"
  | "confirmed"
  | "executing"
  | "completed"
  | "partially_completed"
  | "failed"
  | "canceled";

export type PayableBatchItemState =
  | "needs_complement"
  | "resolving"
  | "ready"
  | "excluded"
  | "rejected"
  | "dispatching"
  | "executed"
  | "refused"
  | "uncertain";

export interface PayableBatchItemCheck {
  /**
   * `carrier_check_digits`, `duplicate_in_batch`, `duplicate_document`, `amount_matches_rail`, `due_date_state`,
   * `pix_key_resolved`; since payables v1.1 also `amount_matches_document`, `rail_switched`, `ways_amount_mismatch`,
   * `ways_unavailable` (their `message` is already the person's sentence).
   */
  code: string;
  status: "pass" | "fail" | "warn";
  message: string;
  /** True when a test project's own responder answered the consult behind this check, not the rail. */
  simulated?: boolean;
}

export interface PayableBatchItemPayment {
  state: "executed" | "refused" | "uncertain";
  attempt_id: string | null;
  receipt_id: string | null;
  end_to_end_id: string | null;
  refusal: { code: string; message: string } | null;
}

export type PayableWayRail = "pix" | "boleto";

/** Why a way cannot be paid now (payables v1.1, rules 5 and 7). */
export type PayableWayUnavailableCode =
  | "br_code_expired"
  | "br_code_not_found"
  | "boleto_expired"
  | "boleto_refused"
  | "rail_unavailable"
  | "no_sandbox_fixture";

export interface PayableBatchItemDestination {
  kind: "boleto" | "pix_key" | "br_code_static" | "br_code_dynamic";
  /** Masked line or masked key. */
  display: string;
  beneficiary_name: string | null;
  beneficiary_document_masked: string | null;
  due_date: string | null;
}

/**
 * One way of paying the item (payables v1.1, rule 2). Two when one page
 * printed a boleto and a Pix code for the same bill; the item is paid ONCE,
 * through `rail`. Choose with `updateItem(..., { rail })`.
 */
export interface PayableBatchItemWay {
  rail: PayableWayRail;
  origin: { page: number | null; kind: PayableBatchItem["origin"]["kind"] };
  /** This way's resolved destination, when the rail answered. */
  destination: PayableBatchItemDestination | null;
  /** Why this way cannot be paid now, in the person's words; null when it can. */
  unavailable: { code: PayableWayUnavailableCode | string; message: string } | null;
}

/** What the page says about the document (payables v1.1, rule 4): shown as such, never confirmed in place of the rail's values. */
export interface PayableBatchItemDocument {
  /** From a closed catalog ("DARE-SP", "Nota Fiscal", ...). */
  title: string | null;
  issuer: string | null;
  /** YYYY-MM-DD. */
  due_date: string | null;
  /** The boleto's effective value or a static BR Code's amount; never loose text. */
  amount_minor: number | null;
}

export interface PayableBatchItem {
  /** `pbl_` + 16 characters: the payable's id, derived from the batch and the item's content. */
  item_id: string;
  position: number;
  origin: {
    file_id: string | null;
    page: number | null;
    row: number | null;
    /** `document`: one boleto and one Pix code of the same page, fused into one item (v1.1). */
    kind: "boleto_line" | "br_code" | "pix_key" | "qr_image" | "barcode_image" | "csv_row" | "manual" | "document";
  };
  /** The chosen way when the item has two; the only way otherwise. */
  rail: "boleto" | "pix" | null;
  /** `default` until a person (dashboard, chat) or an integration (API key) chose with `updateItem(..., { rail })`. */
  rail_chosen_by: "default" | "person" | "integration";
  /** 1 or 2 entries, in order of preference (Pix first). */
  ways: PayableBatchItemWay[];
  document: PayableBatchItemDocument | null;
  state: PayableBatchItemState;
  /** `rail`: the two ways state different amounts and nobody chose yet (v1.1). */
  missing: Array<"amount" | "destination" | "pix_key_owner_confirmation" | "rail">;
  /** Resolved on the rail: what the person confirms, not what was extracted. */
  destination: PayableBatchItemDestination | null;
  amount_minor: number | null;
  /** `document`: the page's own amount, shown until the rail quote replaces it. */
  amount_source: "rail_quote" | "br_code" | "stated_by_person" | "csv" | "document" | null;
  description: string | null;
  reference: string | null;
  checks: PayableBatchItemCheck[];
  payment: PayableBatchItemPayment | null;
}

export interface PayableBatchConfirmation {
  version: number;
  list_hash: string;
  /** `user_…` or `api_key:ak_…`. */
  confirmed_by: string;
  confirmed_at: string;
  mandate_id: string;
}

export interface PayableBatch {
  batch_id: string;
  status: PayableBatchStatus;
  /** Bumps on every change to the list; `pay` binds to it. */
  version: number;
  /** sha256 over the canonical list; `pay` binds to it. */
  list_hash: string;
  currency: "BRL";
  totals: { items: number; payable_items: number; excluded: number; amount_minor: number };
  confirmation: PayableBatchConfirmation | null;
  items: PayableBatchItem[];
  created_at: string;
  source: PayableBatchSource;
  conversation_id: string | null;
}

/** `batches.create` answers the batch plus whether it replays an earlier call with the same key. */
export interface PayableBatchCreated extends PayableBatch {
  idempotent_replay: boolean;
}

export type PayableBatchSource = "api" | "chat" | "dashboard" | "cli" | "mcp";

/** A charge stated directly instead of read from a file. One carrier per item. */
export interface PayableItemInput {
  pixKey?: string;
  boletoLine?: string;
  brCode?: string;
  /** Required with a bare Pix key: the key never determines the amount. */
  amountMinor?: number;
  description?: string;
  /** Your own reference; part of the item identity for re-sends. */
  reference?: string;
}

export interface PayableBatchCreateInput {
  fileIds?: string[];
  items?: PayableItemInput[];
  /** Defaults to `api` on the server. */
  source?: PayableBatchSource;
  conversationId?: string;
}

export interface PayableItemUpdate {
  /** The `version` you reviewed; a stale one is refused with 409 `payable_batch_version_conflict`. */
  expectedVersion: number;
  amountMinor?: number;
  pixKey?: string;
  boletoLine?: string;
  brCode?: string;
  description?: string;
  excluded?: boolean;
  /**
   * The way to pay an item that has two (`ways`, payables v1.1): the item
   * re-resolves on it. Refused with 409 `payable_item_rail_unavailable` when
   * the item has no such way or it is unavailable (`error.details.unavailable`).
   */
  rail?: PayableWayRail;
}

export interface PayableItemsAddInput {
  expectedVersion: number;
  fileIds?: string[];
  items?: PayableItemInput[];
}

export interface PayableBatchPayInput {
  /** The `version` and `list_hash` of the list you are confirming. */
  version: number;
  listHash: string;
  /** Required with an API key: the mandate is the authorization. */
  mandateId?: string;
}

export interface PayableUploadOptions extends CallOptions {
  /** Defaults to the File's name, the stream's path basename, or `document`. */
  filename?: string;
  /** Sets the part's type when the input carries none. The API decides by magic bytes either way. */
  contentType?: string;
}

export interface PayableIdempotentOptions extends CallOptions {
  idempotencyKey?: string;
}

/* ── Wallet: Pix keys of a consumer's own account (/v1/consumers/:consumerId/pix-keys) ── */

export type PixKeyType = "EVP" | "CPF" | "CNPJ" | "EMAIL" | "PHONE";

/** One key as the bank lists it. */
export interface PixKey {
  key: string;
  key_type: PixKeyType | (string & {});
}

/** `GET /v1/consumers/:consumerId/pix-keys`. */
export interface PixKeyList {
  /** `••••NN`, the account's last two digits. */
  account_masked: string;
  keys: PixKey[];
  count: number;
}

export interface PixKeyRegisterInput {
  /** Explicit, EVP included: a random key is never minted by omission. */
  keyType: PixKeyType;
  /** The key value for CPF, CNPJ, EMAIL and PHONE; absent for EVP (the bank mints it). */
  key?: string;
}

/** `POST /v1/consumers/:consumerId/pix-keys`, 201. */
export interface PixKeyRegistered {
  key: string;
  key_type: PixKeyType | (string & {});
  account_masked: string;
  cache_filled?: boolean;
  /** True when the key came from re-reading the account's list because the bank's answer was unreadable. */
  reconciled?: boolean;
}

/** `DELETE /v1/consumers/:consumerId/pix-keys/:key`. */
export interface PixKeyDeleted {
  key: string;
  account_masked: string;
  deleted: true;
  cache_cleared?: boolean;
  cache_refilled_with?: string | null;
}

export interface PixKeyDeleteOptions extends CallOptions {
  /** True only after the person confirmed. Anything else sends nothing. */
  confirm: boolean;
}
