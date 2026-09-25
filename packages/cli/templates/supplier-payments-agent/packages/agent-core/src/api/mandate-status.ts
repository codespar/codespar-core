/**
 * Mandate status from the API: `GET /v1/mandates/{id}`, the one registered
 * spelling of the consumer-allowance point read (the SDK's OpenAPI says the
 * path has no alias; `/v1/consumers/mandates/{id}` answers 404 on staging,
 * measured 2026-09-23). Consulted before `executing` (section 4.7), through
 * the same `csk_test_` client every other call of the kit uses.
 *
 * Fail-closed: this source never throws and never assumes. A transport
 * failure, a timeout, a 404, a 5xx, an unreadable body or a status outside
 * `active | paused | revoked | expired` is reported as `unknown`, and the
 * engine executes nothing on `unknown`.
 *
 * The organization kill switch (`org pauseAll`) has no API surface, so
 * `org_paused` is `false` here: the API cannot say it, and this source does
 * not invent it.
 */
import type { ApiClient } from "@codespar/sdk";
import { z } from "zod";
import type { MandateStatusReport, MandateStatusSource } from "../revocation.js";
import { describeApiError } from "./client.js";

/** The two fields of the 14-field projection the gate reads; the rest is passed through untouched. */
const MandateReadSchema = z
  .object({
    status: z.enum(["active", "paused", "revoked", "expired"]),
    expires_at: z.string(),
  })
  .passthrough();

export class ApiMandateStatusSource implements MandateStatusSource {
  constructor(
    private readonly api: ApiClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(mandateId: string): Promise<MandateStatusReport> {
    const base = { mandate_id: mandateId, org_paused: false, checked_at: this.clock().toISOString(), source: "api" as const };
    let body: unknown;
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
    const parsed = MandateReadSchema.safeParse(body);
    if (!parsed.success) {
      const status = body && typeof body === "object" && "status" in body ? String((body as { status: unknown }).status) : "missing";
      return { ...base, status: "unknown", detail: `GET /v1/mandates/${mandateId} answered a status this kit does not read (${status})` };
    }
    const expiresAt = new Date(parsed.data.expires_at).getTime();
    const expired = Number.isFinite(expiresAt) && expiresAt <= this.clock().getTime();
    return { ...base, status: expired && parsed.data.status === "active" ? "expired" : parsed.data.status };
  }
}
