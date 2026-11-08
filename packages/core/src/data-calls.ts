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
import type { DataCall, DataCallCreated, DataCallCreateInput, DataCallNextAction, DataCallRead } from "@codespar/types";
import type { CallOptions } from "./types.js";

export type { DataCall, DataCallCreated, DataCallCreateInput, DataCallNextAction, DataCallRead };

/**
 * A key asked to run a data call: the API refused it (`person_required`, 403) and handed the protected action.
 * `nextAction.url` is the call's card on the dashboard, behind the person's sign-in. Nothing was run. Hand the url to
 * the person, then read the call by id (`get`) until `dataCallOutcome` is no longer `pending`.
 */
export class DataCallNeedsPersonError extends CodesparApiError {
  readonly nextAction: DataCallNextAction | null;
  constructor(cause: CodesparApiError, nextAction: DataCallNextAction | null) {
    super(cause.message, { status: cause.status, code: cause.code, body: cause.body, cause });
    Object.setPrototypeOf(this, DataCallNeedsPersonError.prototype);
    this.name = "DataCallNeedsPersonError";
    this.nextAction = nextAction;
  }
}

/** The protected action in a `person_required` refusal's details, or null. */
export function nextActionOfError(err: unknown): DataCallNextAction | null {
  const body = (err as { body?: unknown } | null)?.body as { error?: { details?: { next_action?: unknown } } } | undefined;
  const n = body?.error?.details?.next_action as DataCallNextAction | undefined;
  return n && n.kind === "person_authorization" && typeof n.url === "string" ? n : null;
}

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
  /**
   * `GET /v1/shop/agent/data-calls/:id`: where it stands, the four states apart, and `next_action` while it waits for
   * the person. A call sent and not known yet is reconciled on this read, never resent: read the same id again,
   * across restarts, until it is no longer pending.
   */
  get(proposalId: string, opts?: CallOptions): Promise<DataCallRead>;
  /**
   * `POST /v1/shop/agent/data-calls/:id/execute`: always refused for a key, thrown as `DataCallNeedsPersonError`
   * carrying `nextAction` (the person's protected action). Present so the refusal is explicit, never a silent no-op.
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
      return call<DataCallRead>("dataCalls.get", one(proposalId), { method: "GET", headers: { ...auth, Accept: "application/json" } }, opts);
    },
    async execute(proposalId, opts) {
      try {
        await call<unknown>("dataCalls.execute", `${one(proposalId)}/execute`, { method: "POST", headers: { ...auth, Accept: "application/json" } }, opts);
      } catch (err) {
        if (err instanceof CodesparApiError && err.code === "person_required") throw new DataCallNeedsPersonError(err, nextActionOfError(err));
        throw err;
      }
      // The route never answers 2xx for a key; reaching here means the API changed under this client.
      throw new Error("dataCalls.execute: the API answered a key's run without person_required; refusing to treat it as run");
    },
  };
}
