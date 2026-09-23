/**
 * The one place the kit talks to the CodeSpar API. The key is checked for
 * the `csk_test_` prefix before the client is built, so no live key ever
 * reaches the network from this repository.
 */
import { ApiClient, CodesparApiError, TimeoutError } from "@codespar/sdk";
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

/** Normalise the SDK's two error classes into one readable shape without leaking the body into logs. */
export function describeApiError(err: unknown): ApiFailure {
  if (err instanceof TimeoutError) return { status: 0, code: "timeout", message: `request timed out after ${err.timeoutMs}ms` };
  if (err instanceof CodesparApiError) {
    const body = err.body as { error?: { code?: string; message?: string } } | undefined;
    return {
      status: err.status,
      code: err.code ?? body?.error?.code ?? (err.status === 0 ? "network" : `http_${err.status}`),
      message: body?.error?.message ?? err.message,
      body: err.body,
    };
  }
  return { status: 0, code: "unknown", message: err instanceof Error ? err.message : String(err) };
}

/** 5xx, timeouts and `psp_dispatch_uncertain` mean "the money may have moved". */
export function isUncertain(failure: ApiFailure): boolean {
  return failure.status === 0 || failure.status >= 500 || failure.code === "psp_dispatch_uncertain" || failure.code === "psp_attempt_uncertain";
}
