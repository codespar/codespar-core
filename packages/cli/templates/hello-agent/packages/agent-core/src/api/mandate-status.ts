/**
 * Mandate status from the API: `GET /v1/mandates/{id}`, the one registered
 * spelling of the consumer-allowance point read (the SDK's OpenAPI says the
 * path has no alias; `/v1/consumers/mandates/{id}` answers 404 on staging,
 * measured 2026-09-23). Consulted before `executing` (section 4.7), through
 * the same `csk_test_` client every other call of the kit uses.
 *
 * Fail-closed: this source never throws and never assumes. A transport
 * failure, a timeout, a 404, a 5xx, an unreadable body, a status outside
 * `active | paused | revoked | expired` or an `org_paused` that is not a
 * boolean is reported as `unknown`, and the engine executes nothing on
 * `unknown`.
 *
 * The organization kill switch (ent#1648) answers on the same read:
 * `org_paused` next to `status`, which stays the mandate's own. A missing
 * `org_paused` is `unknown`, never "not paused": a deployment that cannot
 * say whether the organization stopped every spend has not said it did not.
 */
import type { ApiOperation, ApiSuccess, ApiClient } from "@codespar/sdk";
import { z } from "zod";
import type { MandateStatusReport, MandateStatusSource } from "../revocation.js";
import { describeApiError } from "./client.js";

/** `GET /v1/mandates/{id}` as the SDK's generated OpenAPI types it. */
type MandateRead = ApiSuccess<ApiOperation<"/v1/mandates/{id}", "get">>;

/**
 * The three fields the gate reads; the rest is passed through untouched.
 * Bound to the SDK's type, so a field the API renames or retypes breaks the
 * compile here instead of reading as absent at run time.
 */
const MandateReadSchema = z
  .object({
    status: z.enum(["active", "paused", "revoked", "expired"]),
    expires_at: z.string(),
    org_paused: z.boolean(),
  })
  .passthrough() satisfies z.ZodType<Pick<MandateRead, "status" | "expires_at" | "org_paused">>;

export class ApiMandateStatusSource implements MandateStatusSource {
  constructor(
    private readonly api: ApiClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(mandateId: string): Promise<MandateStatusReport> {
    const base = { mandate_id: mandateId, org_paused: false, checked_at: this.clock().toISOString(), source: "api" as const };
    let body: MandateRead;
    try {
      body = await this.api.get("/v1/mandates/{id}", { path: { id: mandateId } });
    } catch (err) {
      const failure = describeApiError(err);
      const detail =
        failure.status === 404
          ? `the API has no mandate ${mandateId} for this key (${failure.code})`
          : `GET /v1/mandates/${mandateId} did not answer (${failure.code}): ${failure.message}`;
      return { ...base, status: "unknown", detail };
    }
    // The type says what the API promises; the parse checks that this answer kept the promise.
    const parsed = MandateReadSchema.safeParse(body);
    if (!parsed.success) {
      const unread = parsed.error.issues.map((issue) => issue.path.join(".") || "body");
      const status = body && typeof body === "object" && "status" in body ? String(body.status) : "missing";
      const detail = unread.includes("org_paused")
        ? `GET /v1/mandates/${mandateId} did not say whether the organization is paused (org_paused unreadable)`
        : `GET /v1/mandates/${mandateId} answered a status this kit does not read (${status})`;
      return { ...base, status: "unknown", detail };
    }
    if (parsed.data.org_paused) return { ...base, org_paused: true, status: parsed.data.status };
    const expiresAt = new Date(parsed.data.expires_at).getTime();
    const expired = Number.isFinite(expiresAt) && expiresAt <= this.clock().getTime();
    return { ...base, status: expired && parsed.data.status === "active" ? "expired" : parsed.data.status };
  }
}
