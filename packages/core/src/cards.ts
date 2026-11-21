/**
 * `cs.cards`: card reads over the REST routes that are not a meta-tool call.
 *
 * `cs.cards.readiness()` is `GET /v1/cards/readiness` (contract §9): per
 * program, whether it is ready for this project and environment and the
 * checklist of what is missing, each step naming who must act. The server
 * computes it with the same function as the issue requirements, so the
 * checklist and an issue refusal never disagree. Read-only.
 */

import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import type { CallOptions, CardReadiness } from "@codespar/types";

interface CardsDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

export interface Cards {
  /** `GET /v1/cards/readiness`: what each program needs before an issue can succeed. */
  readiness(opts?: CallOptions): Promise<CardReadiness>;
}

export function createCards(deps: CardsDeps): Cards {
  const headers: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}`, Accept: "application/json" };
  if (deps.projectId) headers["x-codespar-project"] = deps.projectId;

  return {
    async readiness(opts) {
      const what = "cards.readiness";
      try {
        return await fetchWithTimeout(
          `${deps.baseUrl}/v1/cards/readiness`,
          { method: "GET", headers },
          { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal },
          async (r) => {
            if (!r.ok) await throwFromResponse(r, what);
            return (await r.json()) as CardReadiness;
          },
        );
      } catch (cause) {
        if (cause instanceof TimeoutError) throw cause;
        if (cause instanceof CodesparApiError) throw cause;
        if (opts?.signal?.aborted) throw cause;
        throw networkErrorToApiError(cause, what);
      }
    },
  };
}
