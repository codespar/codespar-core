/**
 * `cs.dataCalls`: Shop G3.1 data calls, over the REST routes
 * (`/v1/shop/agent/data-calls`).
 *
 * A data call is a per-call data service offered by a provider and found by
 * a research of `taskKind: "data_service"` (`session.research.create`). A key
 * DRAFTS one from such an offer; it never runs it. Running reserves the
 * Wallet and makes the provider's call: that is the person's authorization,
 * so `execute` with a key always answers `person_required` (403). The person
 * runs it in the Shop or through an MCP client with their login.
 *
 * Every answer is the API's wire (snake_case), with the four states apart:
 * `quotation`, `authorization`, `commitment` (the call at the provider),
 * `payment` (Wallet) and `confirmation`. None is inferred from another: a
 * debited payment with an uncertain call is exactly that, never "success".
 * `dataCallOutcome` reads them into one word for a program to branch on.
 */

import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import type { DataCall, DataCallCreated, DataCallCreateInput } from "@codespar/types";
import type { CallOptions } from "./types.js";

export type { DataCall, DataCallCreated, DataCallCreateInput };

interface DataCallsDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

/**
 * One word for a program to branch on, read from the four states:
 *   `succeeded`  the provider's result is confirmed (call id and result ref)
 *   `uncertain`  the call was sent and its outcome is not known yet; reading it again reconciles it, nothing resends
 *   `refused`    nothing was made: the terms changed, the provider refused, the call was cancelled
 *   `failed`     the call ended without a result after it was sent
 *   `pending`    drafted or running: the person still has to run it, or it is in flight
 */
export type DataCallOutcome = "succeeded" | "uncertain" | "refused" | "failed" | "pending";

export function dataCallOutcome(d: DataCall): DataCallOutcome {
  if (d.confirmation.state === "confirmed") return "succeeded";
  if (d.commitment.state === "uncertain") return "uncertain";
  if (d.error || d.commitment.state === "cancelled" || d.run_state === "cancelled") return "refused";
  if (d.commitment.state === "failed" || d.confirmation.state === "failed") return "failed";
  return "pending";
}

export interface DataCalls {
  /** `POST /v1/shop/agent/data-calls`: draft a data call from a `data_service` offer. Nothing is reserved or sent. */
  create(input: DataCallCreateInput, opts?: CallOptions): Promise<DataCallCreated>;
  /** `GET /v1/shop/agent/data-calls/:id`: where it stands, the four states apart. */
  get(proposalId: string, opts?: CallOptions): Promise<DataCall>;
  /**
   * `POST /v1/shop/agent/data-calls/:id/execute`: always refused for a key (`person_required`, 403), thrown as
   * `CodesparApiError`. Present so the refusal is explicit, never a silent no-op.
   */
  execute(proposalId: string, opts?: CallOptions): Promise<never>;
}

export function createDataCalls(deps: DataCallsDeps): DataCalls {
  const auth: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  if (deps.projectId) auth["x-codespar-project"] = deps.projectId;

  async function call<T>(what: string, url: string, init: Omit<RequestInit, "signal">, opts: CallOptions | undefined): Promise<T> {
    try {
      return await fetchWithTimeout(url, init, { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal }, async (r) => {
        if (!r.ok) await throwFromResponse(r, what);
        return (await r.json()) as T;
      });
    } catch (cause) {
      if (cause instanceof TimeoutError) throw cause;
      if (cause instanceof CodesparApiError) throw cause;
      if (opts?.signal?.aborted) throw cause;
      throw networkErrorToApiError(cause, what);
    }
  }

  const base = `${deps.baseUrl}/v1/shop/agent/data-calls`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

  return {
    async create(input, opts) {
      return call<DataCallCreated>(
        "dataCalls.create",
        base,
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ agent_id: input.agentId, offer_id: input.offerId, idempotency_key: input.idempotencyKey }),
        },
        opts,
      );
    },
    async get(proposalId, opts) {
      const r = await call<{ data_call: DataCall }>("dataCalls.get", one(proposalId), { method: "GET", headers: { ...auth, Accept: "application/json" } }, opts);
      return r.data_call;
    },
    async execute(proposalId, opts) {
      await call<unknown>("dataCalls.execute", `${one(proposalId)}/execute`, { method: "POST", headers: { ...auth, Accept: "application/json" } }, opts);
      // The route never answers 2xx for a key; reaching here means the API changed under this client.
      throw new Error("dataCalls.execute: the API answered a key's run without person_required; refusing to treat it as run");
    },
  };
}
