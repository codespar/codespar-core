import { CliError, type CliConfig } from "./config.js";

/**
 * Thin fetch wrapper around the CodeSpar REST API. The SDK doesn't expose
 * every endpoint the CLI needs (catalog listings, session bookkeeping),
 * so we hit the HTTP surface directly with the user's API key.
 */
export class ApiClient {
  constructor(private readonly config: Required<Pick<CliConfig, "apiKey" | "baseUrl">>) {}

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

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "codespar-cli/0.1.0",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new CliError(
        `Network error calling ${method} ${url.pathname}: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      let detail = "";
      try {
        const errBody = (await res.json()) as { message?: string; error?: string };
        detail = errBody.message ?? errBody.error ?? "";
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
