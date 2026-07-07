/**
 * Structured exception for every transport-failure path through the
 * SDK. Replaces the old `throw new Error("send failed: 500 ...")`
 * shape, so callers can branch on `e.code` rather than parsing
 * `e.message` strings.
 *
 * The reserved code namespace covers the hosted-test-mode wire
 * contract (tool-result codes + create-time envelope codes —
 * see the README's "Reserved error codes" section). Customers
 * extending CodesparApiError should prefix their own codes (e.g.
 * `"myapp.policy_denied"`) to avoid collision with reserved values.
 *
 * `status: 0` is reserved for network errors that never reached the
 * backend; the underlying `cause` carries the original `TypeError`
 * or `DOMException` that `fetch` rejected with.
 */
export interface CodesparApiErrorOptions {
  status: number;
  code?: string;
  body?: unknown;
  cause?: unknown;
}

export class CodesparApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(message: string, options: CodesparApiErrorOptions) {
    // ES2022 `cause` shape — supported by Node 20 + modern browsers.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    // Restore the prototype chain — without this, `instanceof
    // CodesparApiError` returns false across some transpilers and
    // realms (the classic ES5-target Error subclass trap).
    Object.setPrototypeOf(this, CodesparApiError.prototype);
    this.name = "CodesparApiError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

interface ParsedErrorBody {
  code?: string;
  message?: string;
}

function parseErrorPayload(raw: string): {
  body: unknown;
  parsed: ParsedErrorBody;
} {
  if (!raw) return { body: undefined, parsed: {} };
  try {
    const body = JSON.parse(raw) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const obj = body as Record<string, unknown>;
      const code = typeof obj.code === "string" ? obj.code : undefined;
      // Legacy fallback: pre-PRD envelopes used `error` as the
      // discriminant. `code` takes precedence; `error` honored only
      // when `code` is missing.
      const fallbackCode =
        code ?? (typeof obj.error === "string" ? (obj.error as string) : undefined);
      const message = typeof obj.message === "string" ? obj.message : undefined;
      return {
        body,
        parsed: { code: fallbackCode, message },
      };
    }
    return { body, parsed: {} };
  } catch {
    return { body: raw, parsed: {} };
  }
}

/**
 * Build the canonical error message + extract the structured code +
 * preserve the parsed body. Centralised so every transport call site
 * surfaces the same shape — a customer parsing `e.message` is
 * already on the deprecated path; new code branches on `e.code`.
 */
export async function throwFromResponse(
  response: Response,
  what: string,
): Promise<never> {
  const raw = await response.text();
  const { body, parsed } = parseErrorPayload(raw);
  const suffix = parsed.message
    ? ` — ${parsed.message}`
    : parsed.code
      ? ` — ${parsed.code}`
      : raw
        ? ` ${raw}`
        : "";
  throw new CodesparApiError(`${what} failed: ${response.status}${suffix}`, {
    status: response.status,
    code: parsed.code,
    body,
  });
}

/**
 * Convert a `fetch` rejection (network error, abort, DNS, TLS, etc.)
 * into a CodesparApiError with `status: 0`. Preserves the underlying
 * error as `cause` so callers debugging a transport failure can dig
 * into the original `TypeError`.
 */
export function networkErrorToApiError(cause: unknown, what: string): CodesparApiError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new CodesparApiError(`${what} network error: ${message}`, {
    status: 0,
    cause,
  });
}

/** Thrown when a request exceeds its timeout (unary total, or stream idle). */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`CodeSpar request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
