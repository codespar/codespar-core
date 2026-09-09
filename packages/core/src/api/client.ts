/**
 * Thin REST client typed by path and method from the served OpenAPI
 * document. There is no per-route code here: the route list, the
 * parameter shapes and the response shapes all come from the generated
 * files under ../generated/, and the only runtime knowledge per
 * operation is the generated table row (body/accept content types).
 *
 * Errors follow the rest of the SDK: `request()` throws
 * `CodesparApiError` on a non-2xx status (the parsed body is on
 * `e.body`), network failures surface as `status: 0`, and timeouts as
 * `TimeoutError`. `response()` returns every documented status as a
 * value instead, for routes where a 402/403/422 body is an outcome to
 * branch on (wallet execute, for one) rather than a failure.
 */

import { API_OPERATIONS } from "../generated/operations.js";
import type {
  ApiMethod,
  ApiOperation,
  ApiPath,
  ApiPathsFor,
  ApiRequestArgs,
  ApiResponse,
  ApiSuccess,
} from "./types.js";
import { fetchWithTimeout, validateTimeout } from "../internal/fetch.js";
import {
  CodesparApiError,
  TimeoutError,
  networkErrorToApiError,
  throwFromResponse,
} from "../errors.js";

export interface ApiClientConfig {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  /** Default per-call timeout in milliseconds. */
  timeout: number;
}

interface OperationRow {
  method: string;
  path: string;
  body: string | null;
  accept: string | null;
}

const OPERATION_INDEX: ReadonlyMap<string, OperationRow> = new Map(
  API_OPERATIONS.map((row) => [`${row.method} ${row.path}`, row]),
);

const SSE = "text/event-stream";
const FORM = "application/x-www-form-urlencoded";

type Primitive = string | number | boolean;

function appendQuery(url: URL, query: unknown): void {
  if (!query || typeof query !== "object") return;
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      url.searchParams.append(
        key,
        typeof v === "object" ? JSON.stringify(v) : String(v as Primitive),
      );
    }
  }
}

/**
 * Expand `{name}` segments with encoded values. A missing value throws
 * before any request is made: an unexpanded `{id}` would reach the
 * backend as a literal and 404 in a way that reads like a data problem.
 */
function expandPath(template: string, params: unknown): string {
  const values = (params ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  const expanded = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined || v === null || v === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(String(v as Primitive));
  });
  if (missing.length) {
    throw new Error(
      `${template}: missing path parameter${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`,
    );
  }
  return expanded;
}

function serialiseBody(contentType: string | null, body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (contentType === FORM) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v !== undefined && v !== null) form.append(k, String(v as Primitive));
    }
    return form;
  }
  return JSON.stringify(body);
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text();
  if (text === "") return undefined;
  const type = res.headers.get("content-type") ?? "";
  if (/\bjson\b/i.test(type)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(config: ApiClientConfig) {
    validateTimeout(config.timeout);
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.timeout = config.timeout;
    this.headers = { Authorization: `Bearer ${config.apiKey}` };
    if (config.projectId) this.headers["x-codespar-project"] = config.projectId;
  }

  /** Every `METHOD /path` the generated client can reach, in document order. */
  static operations(): ReadonlyArray<{ method: ApiMethod; path: ApiPath }> {
    return API_OPERATIONS.map((row) => ({ method: row.method, path: row.path }));
  }

  /**
   * Call an operation and return the documented 2xx data. Non-2xx
   * statuses throw `CodesparApiError` with the parsed body on `e.body`.
   * `text/event-stream` operations resolve to the raw `Response` once
   * headers arrive; its body stays bound to `signal`, not to `timeout`.
   */
  request<M extends ApiMethod, P extends ApiPathsFor<M>>(
    method: M,
    path: P,
    ...args: ApiRequestArgs<ApiOperation<P, M>>
  ): Promise<ApiSuccess<ApiOperation<P, M>>> {
    return this.dispatch(method, path, args[0], "throw") as Promise<
      ApiSuccess<ApiOperation<P, M>>
    >;
  }

  /**
   * Call an operation and return whatever documented status came back,
   * as `{ status, ok, data, response }` discriminated on `status`. Only
   * transport failures (network, timeout, abort) throw.
   */
  response<M extends ApiMethod, P extends ApiPathsFor<M>>(
    method: M,
    path: P,
    ...args: ApiRequestArgs<ApiOperation<P, M>>
  ): Promise<ApiResponse<ApiOperation<P, M>>> {
    return this.dispatch(method, path, args[0], "return") as Promise<
      ApiResponse<ApiOperation<P, M>>
    >;
  }

  get<P extends ApiPathsFor<"get">>(path: P, ...args: ApiRequestArgs<ApiOperation<P, "get">>) {
    return this.request("get", path, ...args);
  }
  post<P extends ApiPathsFor<"post">>(path: P, ...args: ApiRequestArgs<ApiOperation<P, "post">>) {
    return this.request("post", path, ...args);
  }
  put<P extends ApiPathsFor<"put">>(path: P, ...args: ApiRequestArgs<ApiOperation<P, "put">>) {
    return this.request("put", path, ...args);
  }
  patch<P extends ApiPathsFor<"patch">>(path: P, ...args: ApiRequestArgs<ApiOperation<P, "patch">>) {
    return this.request("patch", path, ...args);
  }
  delete<P extends ApiPathsFor<"delete">>(path: P, ...args: ApiRequestArgs<ApiOperation<P, "delete">>) {
    return this.request("delete", path, ...args);
  }

  private async dispatch(
    method: string,
    path: string,
    options: unknown,
    mode: "throw" | "return",
  ): Promise<unknown> {
    const row = OPERATION_INDEX.get(`${method} ${path}`);
    if (!row) {
      throw new Error(
        `${method.toUpperCase()} ${path} is not an operation of the OpenAPI document this client was generated from`,
      );
    }
    const what = `${method.toUpperCase()} ${path}`;
    const opts = (options ?? {}) as Record<string, unknown> & {
      timeout?: number;
      signal?: AbortSignal;
    };
    const timeout = opts.timeout ?? this.timeout;
    validateTimeout(timeout);

    const url = new URL(this.baseUrl + expandPath(path, opts.path));
    appendQuery(url, opts.query);

    const headers: Record<string, string> = { ...this.headers };
    if (row.accept) headers.Accept = row.accept;
    if (row.body && opts.body !== undefined) headers["Content-Type"] = row.body;
    for (const [k, v] of Object.entries((opts.header ?? {}) as Record<string, unknown>)) {
      if (v !== undefined && v !== null) headers[k] = String(v as Primitive);
    }

    const init: Omit<RequestInit, "signal"> = {
      method: method.toUpperCase(),
      headers,
      body: row.body ? serialiseBody(row.body, opts.body) : undefined,
    };

    if (row.accept === SSE) {
      return this.stream(url, init, what, timeout, opts.signal, mode);
    }

    try {
      return await fetchWithTimeout(url.toString(), init, { timeout, signal: opts.signal }, async (res) => {
        if (mode === "throw") {
          if (!res.ok) await throwFromResponse(res, what);
          return readBody(res);
        }
        return { status: res.status, ok: res.ok, data: await readBody(res), response: res };
      });
    } catch (cause) {
      throw this.transportError(cause, what, opts.signal);
    }
  }

  // An SSE response is returned as soon as headers arrive. The timeout
  // covers connect + headers only (a stream has no natural end for a
  // total budget); the caller's signal stays attached so aborting it
  // still cancels the body. Mirrors session.paymentStatusStream, which
  // remains the ergonomic path for the two status streams.
  private async stream(
    url: URL,
    init: Omit<RequestInit, "signal">,
    what: string,
    timeout: number,
    signal: AbortSignal | undefined,
    mode: "throw" | "return",
  ): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new TimeoutError(timeout)), timeout);
    const onAbort = () => ac.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(url.toString(), { ...init, signal: ac.signal });
      if (mode === "throw") {
        if (!res.ok) await throwFromResponse(res, what);
        return res;
      }
      const data = res.ok ? res : await readBody(res);
      return { status: res.status, ok: res.ok, data, response: res };
    } catch (cause) {
      if (ac.signal.reason instanceof TimeoutError && !signal?.aborted) throw ac.signal.reason;
      throw this.transportError(cause, what, signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private transportError(cause: unknown, what: string, signal?: AbortSignal): unknown {
    if (cause instanceof TimeoutError) return cause;
    if (cause instanceof CodesparApiError) return cause;
    if (signal?.aborted) return cause;
    return networkErrorToApiError(cause, what);
  }
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config);
}
