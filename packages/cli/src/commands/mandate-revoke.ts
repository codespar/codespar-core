import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { json, success } from "../output.js";

export interface MandateRevokeOptions {
  /** Recorded in the evidence row's metadata; never echoed back. Max 280 chars server-side. */
  reason?: string;
  json?: boolean;
}

/**
 * Revoke a consumer mandate — the terminal verb of the org-scoped
 * lifecycle (pause / resume / revoke).
 *
 * `POST /v1/mandates/{id}/revoke` is the canonical spelling (ent#979);
 * `/v1/consumers/mandates/{id}/revoke` is the deprecated alias and is not
 * used here. The route moves an `active` or `paused` allowance to
 * `revoked`, appends the LGPD evidence row in the same transaction and
 * publishes `commerce.mandate.revoked`. Idempotent: a mandate already
 * revoked answers 200 with `changed: false` and writes nothing, which is
 * why the command reports that case rather than treating it as an error.
 * `expired` answers 409 `invalid_transition` — expiry is already terminal.
 */
export async function mandateRevokeCommand(
  client: ApiClient,
  id: string,
  opts: MandateRevokeOptions = {},
): Promise<void> {
  if (!id) throw new CliError("Mandate id is required.");
  const body = opts.reason === undefined ? undefined : { reason: opts.reason };
  const result = await client.post("/v1/mandates/{id}/revoke", {
    path: { id },
    ...(body === undefined ? {} : { body }),
  });
  success(
    result.changed
      ? `Mandate ${result.mandate.id} revoked.`
      : `Mandate ${result.mandate.id} was already revoked; nothing changed.`,
  );
  if (opts.json) json(result);
}
