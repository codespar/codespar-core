import { CliError } from "./config.js";
import { VERSION } from "./version.js";

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

/**
 * Thin fetch wrapper around the CodeSpar REST API. The SDK doesn't expose
 * every endpoint the CLI needs (catalog listings, session bookkeeping),
 * so we hit the HTTP surface directly with the user's API key.
 */
export class ApiClient {
  private readonly timeoutMs: number;

  constructor(private readonly config: ApiClientConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.config.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": `codespar-cli/${VERSION}`,
    };
    if (this.config.project) headers["x-codespar-project"] = this.config.project;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new CliError(
          `Request to ${method} ${url.pathname} timed out after ${this.timeoutMs}ms.`,
        );
      }
      throw new CliError(
        `Network error calling ${method} ${url.pathname}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = "";
      try {
        // The API returns either `{ message }` or the nested envelope
        // `{ error: { code, message } }` (newer routes). Handle both so the
        // human-readable message surfaces instead of "[object Object]".
        const errBody = (await res.json()) as {
          message?: string;
          error?: string | { code?: string; message?: string };
        };
        const nested =
          typeof errBody.error === "object" && errBody.error ? errBody.error : null;
        detail =
          errBody.message ??
          nested?.message ??
          (typeof errBody.error === "string" ? errBody.error : "") ??
          "";
      } catch {
        detail = await res.text().catch(() => "");
      }
      const prefix = `${method} ${url.pathname} → ${res.status}`;
      throw new CliError(detail ? `${prefix}: ${detail}` : prefix);
    }

    // 204 No Content
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
