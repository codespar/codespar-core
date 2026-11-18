/**
 * codespar_card result normalization.
 *
 * The wire answers four ways and the caller should not have to know which
 * transport carried a refusal:
 *   - success, action=issue, a non-final `state` -> as received:
 *       `pending_human` (a person must act), `processing`, `uncertain`
 *       (both resolved on the SAME idempotency_key); a definitive failure is a refusal
 *   - success, action=issue, `state: "issued"`    -> CardIssued (the view nested in `card`)
 *   - success, action=issue, anything else         -> throws: an issue answer always says its state
 *   - success, any other action                  -> CardView / CardList as received
 *   - failure WITH a stable code                 -> CardRefusal (returned, not thrown)
 *
 * A failure with a code arrives either as the tool envelope's `data`
 * (`{ error, code, details? }`, a strategy refusal on /execute) or as the
 * `"<status>: <body>"` string `execute()` builds from a non-2xx answer (a
 * scope refusal, say). Both are read here. A failure with no code
 * ("Tool not registered: ...", a 5xx with an HTML body) still throws: it is
 * not a decision the caller can act on.
 */

import type {
  CardArgs,
  CardIssueResult,
  CardIssued,
  CardList,
  CardRefusal,
  CardResult,
  CardView,
  ToolResult,
} from "@codespar/types";

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CODE = /^[a-z][a-z0-9_]*$/;

function bodyOfHttpError(error: string | null): { status: number; body: Rec } | null {
  if (!error) return null;
  const m = /^(\d{3}): ([\s\S]*)$/.exec(error);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[2]!) as unknown;
    return isRecord(parsed) ? { status: Number(m[1]), body: parsed } : null;
  } catch {
    return null;
  }
}

/** The refusal a failed envelope carries, or null when it carries no stable code. */
export function cardRefusalFrom(result: ToolResult): CardRefusal | null {
  const http = isRecord(result.data) ? null : bodyOfHttpError(result.error);
  const body = isRecord(result.data) ? result.data : http?.body;
  if (!body) return null;

  // `{ error: { code, message, details } }` (newer REST routes) or flat.
  const nested = isRecord(body.error) ? body.error : null;
  const flat = nested ?? body;
  const code =
    typeof flat.code === "string"
      ? flat.code
      : typeof flat.error === "string" && CODE.test(flat.error)
        ? flat.error
        : null;
  if (!code) return null;

  const details = isRecord(flat.details) ? flat.details : {};
  const pick = (k: string): unknown => (details[k] !== undefined ? details[k] : flat[k]);
  const message =
    typeof flat.message === "string"
      ? flat.message
      : typeof flat.error === "string" && flat.error !== code
        ? flat.error
        : (result.error ?? null);

  // The body's own `http_status` (the REST status the tool result mirrors)
  // wins over the transport's: a tool envelope always travels as 200.
  const httpStatus = typeof body.http_status === "number" ? body.http_status : (http?.status ?? 200);
  const refusal: CardRefusal = { state: "refused", code, message, http_status: httpStatus, raw: body };
  const reason = pick("reason");
  if (typeof reason === "string") refusal.reason = reason;
  const programs = pick("available_programs");
  if (Array.isArray(programs)) refusal.available_programs = programs as CardRefusal["available_programs"];
  const issuer = pick("issuer");
  if (typeof issuer === "string") refusal.issuer = issuer as CardRefusal["issuer"];
  const program = pick("program");
  if (typeof program === "string") refusal.program = program as CardRefusal["program"];
  const action = pick("action");
  if (typeof action === "string") refusal.action = action as CardRefusal["action"];
  const requestId = pick("issue_request_id");
  if (typeof requestId === "string") refusal.issue_request_id = requestId;
  const failure = pick("failure_code");
  if (typeof failure === "string") refusal.failure_code = failure;
  const actions = pick("available_actions");
  if (Array.isArray(actions)) refusal.available_actions = actions as CardRefusal["available_actions"];
  return refusal;
}

const NON_FINAL_ISSUE_STATES: ReadonlySet<string> = new Set(["pending_human", "processing", "uncertain"]);

/** Turn a codespar_card envelope into the typed result, or throw on a failure with no code. */
export function cardResultFrom(args: CardArgs, result: ToolResult): CardResult {
  if (!result.success) {
    const refusal = cardRefusalFrom(result);
    if (refusal) return refusal;
    throw new Error(`card failed: ${result.error ?? "unknown"}`);
  }
  const data = result.data;
  if (!isRecord(data)) {
    throw new Error("card failed: malformed response");
  }
  if (args.action === "issue") {
    if (typeof data.state === "string" && NON_FINAL_ISSUE_STATES.has(data.state)) {
      return data as unknown as CardIssueResult;
    }
    if (data.state === "issued") return data as unknown as CardIssued;
    throw new Error(`card failed: unexpected issue state ${JSON.stringify(data.state)}`);
  }
  return data as unknown as CardView | CardList;
}

/** Refuse locally what the server would refuse anyway, before anything leaves the machine. */
export function assertCardArgs(args: CardArgs): void {
  if (args.action === "issue" && !args.idempotency_key) {
    throw new Error("card: idempotency_key is required on action=issue");
  }
}
