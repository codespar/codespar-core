/**
 * The one place the kit talks to the CodeSpar API. The key is checked for
 * the `csk_test_` prefix before the client is built, so no live key ever
 * reaches the network from this repository.
 */
import { ApiClient, CodesparApiError, TimeoutError, type ApiOperation, type ApiResponse } from "@codespar/sdk";
import { assertTestKey } from "../secrets.js";

export const DEFAULT_BASE_URL = "https://api.codespar.dev";

export interface CodeSparClientOptions {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  projectId?: string | undefined;
  timeoutMs?: number;
}

export function createCodeSparClient(options: CodeSparClientOptions): ApiClient {
  const apiKey = assertTestKey(options.apiKey);
  return new ApiClient({
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    apiKey,
    ...(options.projectId ? { projectId: options.projectId } : {}),
    timeout: options.timeoutMs ?? 30_000,
  });
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  body?: unknown;
}

/**
 * The `error.code` values an operation documents on its non-2xx answers, read
 * from the SDK's generated types. A code the kit branches on is declared
 * against this, so a code the API stops documenting fails `tsc`.
 */
export type ApiErrorCode<Op> = Extract<ApiResponse<Op>, { ok: false }>["data"] extends infer D ? (D extends { error: { code: infer C } } ? C : never) : never;

/** The codes both spend routes document; the rail takes either. */
export type SpendErrorCode = ApiErrorCode<ApiOperation<"/v1/consumers/mandates/{id}/spend", "post">> & ApiErrorCode<ApiOperation<"/v1/consumer-payments/execute", "post">>;

const UNCERTAIN_CODES: readonly SpendErrorCode[] = ["psp_dispatch_uncertain", "psp_attempt_uncertain"];

/** The thrown error's body is `unknown` to the SDK, whatever the route documents; this reads `{ error: { code, message } }` off it without a cast. */
function errorEnvelope(body: unknown): { code?: string; message?: string } {
  if (!body || typeof body !== "object" || !("error" in body)) return {};
  const error = body.error;
  if (!error || typeof error !== "object") return {};
  return {
    ...("code" in error && typeof error.code === "string" ? { code: error.code } : {}),
    ...("message" in error && typeof error.message === "string" ? { message: error.message } : {}),
  };
}

/** Normalise the SDK's two error classes into one readable shape without leaking the body into logs. */
export function describeApiError(err: unknown): ApiFailure {
  if (err instanceof TimeoutError) return { status: 0, code: "timeout", message: `request timed out after ${err.timeoutMs}ms` };
  if (err instanceof CodesparApiError) {
    const envelope = errorEnvelope(err.body);
    return {
      status: err.status,
      code: err.code ?? envelope.code ?? (err.status === 0 ? "network" : `http_${err.status}`),
      message: envelope.message ?? err.message,
      body: err.body,
    };
  }
  return { status: 0, code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** 5xx, timeouts and `psp_dispatch_uncertain` mean "the money may have moved". */
export function isUncertain(failure: ApiFailure): boolean {
  return failure.status === 0 || failure.status >= 500 || UNCERTAIN_CODES.some((code) => code === failure.code);
}
