import type {
  ApiOperation,
  ApiPathsFor,
  ApiRequestOptions,
  ApiSuccess,
} from "@codespar/sdk";

import { CliError } from "./config.js";
import { VERSION } from "./version.js";

/**
 * An answer from the API that was not 2xx.
 *
 * WHY IT IS A SUBCLASS OF CliError. It prints exactly like any other refusal:
 * one red line on stderr, no stack. What changes is what a script gets. The
 * eleven commands on this client used to report every 401, 404 and 500 as
 * `kind: "cli"` — the kind that means "the CLI refused before reaching the
 * API" — with the status readable only by parsing the message, while the
 * generated resource commands, which go through the SDK's client, answered
 * the same 401 with `kind: "api"`, `status` and `body`. One binary, one
 * `--json`, two contracts, and `kind` separating nothing. Measured on
 * 0.11.3: `wallet`, `servers list`, `sessions list` and `whoami` all said
 * `cli` for a 401; `consumers list` said `api` with `status: 401`.
 */
export class HttpError extends CliError {
  readonly status: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(message: string, opts: { status: number; code?: string; body?: unknown }) {
    super(message);
    this.name = "HttpError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

export interface ApiClientConfig {
  apiKey: string;
  baseUrl: string;
  /** Resolved project. When set, every request carries `x-codespar-project`
   *  so multi-project orgs scope to the right project (without it the org
   *  default is used server-side). */
  project?: string;
  /** Per-request timeout in ms. Default 30s. Streaming commands (logs tail,
   *  payment-status --stream) use their own long-lived path, not this. */
  timeoutMs?: number;
}

/** `[opts?]` when the operation declares nothing required, `[opts]` otherwise. */
type RequestArgs<Op> = {} extends ApiRequestOptions<Op>
  ? [options?: ApiRequestOptions<Op>]
  : [options: ApiRequestOptions<Op>];

type Options = {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  header?: Record<string, unknown>;
  timeout?: number;
};

/**
 * Expand `{name}` segments with encoded values, refusing before the request
 * when one is missing: an unexpanded `{id}` reaches the backend as a literal
 * and 404s in a way that reads to the user like a bad id.
 */
function expandPath(template: string, params: Record<string, unknown> | undefined): string {
  const values = params ?? {};
  const missing: string[] = [];
  const expanded = template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") {
      missing.push(name);
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length > 0) {
    throw new CliError(
      `${template}: missing path parameter${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`,
    );
  }
  return expanded;
}

/**
 * The CLI's REST client, typed by the served OpenAPI document.
 *
 * `path` is a path TEMPLATE the document declares, and the response type is
 * the one the document declares for it — so a route that does not exist, and
 * a field the payload does not carry, are both compile errors rather than a
 * 404 or a `Cannot read properties of undefined` in the user's terminal.
 * Both had shipped: `codespar servers list` read `data.data` from a payload
 * whose array is `servers`, and crashed for every user who ran it (core#130).
 *
 * It stays separate from the SDK's `cs.api`, which the derived resource
 * commands dispatch through, for one reason: the `codespar-cli/<version>`
 * User-Agent and the CliError message shape. The typing here is the SDK's,
 * imported, not a second copy.
 */
export class ApiClient {
  private readonly timeoutMs: number;

  constructor(private readonly config: ApiClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  get<P extends ApiPathsFor<"get">>(
    path: P,
    ...args: RequestArgs<ApiOperation<P, "get">>
  ): Promise<ApiSuccess<ApiOperation<P, "get">>> {
    return this.request("GET", path, args[0] as Options) as Promise<
      ApiSuccess<ApiOperation<P, "get">>
    >;
  }

  post<P extends ApiPathsFor<"post">>(
    path: P,
    ...args: RequestArgs<ApiOperation<P, "post">>
  ): Promise<ApiSuccess<ApiOperation<P, "post">>> {
    return this.request("POST", path, args[0] as Options) as Promise<
      ApiSuccess<ApiOperation<P, "post">>
    >;
  }

  patch<P extends ApiPathsFor<"patch">>(
    path: P,
    ...args: RequestArgs<ApiOperation<P, "patch">>
  ): Promise<ApiSuccess<ApiOperation<P, "patch">>> {
    return this.request("PATCH", path, args[0] as Options) as Promise<
      ApiSuccess<ApiOperation<P, "patch">>
    >;
  }

  delete<P extends ApiPathsFor<"delete">>(
    path: P,
    ...args: RequestArgs<ApiOperation<P, "delete">>
  ): Promise<ApiSuccess<ApiOperation<P, "delete">>> {
    return this.request("DELETE", path, args[0] as Options) as Promise<
      ApiSuccess<ApiOperation<P, "delete">>
    >;
  }

  /**
   * Call a route the served document does not declare.
   *
   * Two of these exist and both are real: `POST /v1/consents/{id}/submit` and
   * `POST /v1/consumers/{id}/wallet/transfer` answer in production (400 and
   * 401 to an unauthenticated probe, against 404 for a route that is absent),
   * but the OpenAPI document the backend serves never mentions them, so
   * neither the generated table nor these types can check the call.
   *
   * It is deliberately not `get`/`post`: every use is debt registered in
   * OFF_SPEC_PATHS, and the name is what makes the debt visible at the call
   * site. The fix for each is in codespar-enterprise — declare the route —
   * after which the call moves to the typed methods above and the entry
   * leaves the register.
   */
  offSpec<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    return this.request(method, path, body === undefined ? {} : { body }) as Promise<T>;
  }

  private async request(method: string, template: string, options: Options = {}): Promise<unknown> {
    const url = new URL(expandPath(template, options.path), this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined || item === null) continue;
        url.searchParams.append(key, typeof item === "object" ? JSON.stringify(item) : String(item));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": `codespar-cli/${VERSION}`,
    };
    // Content-Type SO quando ha corpo.
    //
    // O header era incondicional, e a API recusa uma requisicao que se anuncia
    // como JSON e chega vazia. Medido em 21/09/2026 contra `api.codespar.dev`
    // com a CLI 0.12.0 do npm:
    //
    //   codespar sessions close ses_...
    //   ✗ DELETE /v1/sessions/ses_... → 400: Body cannot be empty when
    //     content-type is set to 'application/json'
    //
    // Fechar sessao era o unico comando deste cliente que manda DELETE, entao
    // era o unico que morria; os GET passavam porque a checagem so vale para
    // metodo que pode carregar corpo. O cliente gerado do SDK ja fazia o
    // certo: medido contra um servidor local, `consumers delete-pix-keys` sai
    // sem content-type nenhum. Um binario, dois clientes, dois comportamentos.
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.config.project) headers["x-codespar-project"] = this.config.project;
    for (const [key, value] of Object.entries(options.header ?? {})) {
      if (value !== undefined && value !== null) headers[key] = String(value);
    }

    const timeoutMs = options.timeout ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new CliError(
          `Request to ${method} ${url.pathname} timed out after ${timeoutMs}ms.`,
        );
      }
      throw new CliError(
        `Network error calling ${method} ${url.pathname}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Read the body ONCE. The first version called `res.json()` and, in the
      // catch, `res.text()` — which always throws after json() has consumed
      // the stream, so a non-JSON error body arrived as an empty detail.
      const raw = await res.text().catch(() => "");
      let detail = raw;
      let body: unknown = raw === "" ? undefined : raw;
      let code: string | undefined;
      try {
        // The API returns either `{ message }` or the nested envelope
        // `{ error: { code, message } }` (newer routes). Handle both so the
        // human-readable message surfaces instead of "[object Object]".
        const errBody = JSON.parse(raw) as {
          code?: string;
          message?: string;
          error?: string | { code?: string; message?: string };
        };
        if (errBody && typeof errBody === "object") {
          body = errBody;
          const nested =
            typeof errBody.error === "object" && errBody.error ? errBody.error : null;
          code =
            errBody.code ??
            nested?.code ??
            (typeof errBody.error === "string" ? errBody.error : undefined);
          detail =
            errBody.message ??
            nested?.message ??
            (typeof errBody.error === "string" ? errBody.error : "") ??
            "";
        }
      } catch {
        // Not JSON: the raw text is the detail, and the body as read.
      }
      const prefix = `${method} ${url.pathname} → ${res.status}`;
      throw new HttpError(detail ? `${prefix}: ${detail}` : prefix, {
        status: res.status,
        code,
        body,
      });
    }

    if (res.status === 204) return undefined;
    return (await res.json()) as unknown;
  }
}
