import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, kv, success } from "../output.js";

interface MandateCreateOptions {
  consumer: string;
  agent: string;
  purpose: string;
  /** Comma-separated allowlist of payees (x402 URL / EVM address / Pix key). */
  payee: string;
  cap: string;
  perTxCap: string;
  currency: string;
  rail: string;
  ttl: string;
  pinKind: string;
  providerToken?: string;
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

/**
 * Create a consumer mandate — the agent's "allowance / wallet" — end to end.
 *
 * Runs the directed-pay consent flow the way an org backend would:
 *   1. POST /v1/consents/init      (authed) mints a one-shot token carrying the
 *      intent (purpose, caps, currency, allowlist).
 *   2. POST /v1/consents/:token/submit (public) provisions the consumer funding
 *      source and signs the mandate with the consumer secret.
 * Prints the mandate id you then hand to `codespar spend`. The consumer's
 * on-chain wallet (for usdc-onchain) is derived from the consumer id, so the
 * same consumer keeps the same wallet across mandates.
 */
export async function mandateCreateCommand(opts: MandateCreateOptions): Promise<void> {
  if (!opts.consumer) throw new CliError("--consumer <id> is required.");
  if (!opts.agent) throw new CliError("--agent <id> is required.");
  if (!opts.purpose) throw new CliError("--purpose <text> is required.");
  const allowlist = (opts.payee ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    throw new CliError(
      "--payee is required (allowlisted payee: x402 URL, EVM address, or Pix key; comma-separated for several).",
    );
  }
  const capMinor = Number(opts.cap);
  const perTxMinor = Number(opts.perTxCap);
  const ttl = Number(opts.ttl);
  if (!Number.isInteger(capMinor) || capMinor <= 0) {
    throw new CliError("--cap must be a positive integer in minor units (cents).");
  }
  if (!Number.isInteger(perTxMinor) || perTxMinor <= 0) {
    throw new CliError("--per-tx-cap must be a positive integer in minor units (cents).");
  }
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new CliError("--ttl must be a positive integer (seconds).");
  }

  const client = new ApiClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    project: opts.project,
  });

  // 1. Mint the consent token (authed).
  const init = await client.post<{ token: string; expires_at: string }>("/v1/consents/init", {
    agent_id: opts.agent,
    intent: {
      purpose: opts.purpose,
      cap_minor: capMinor,
      per_tx_cap_minor: perTxMinor,
      currency: opts.currency,
      mandate_ttl_seconds: ttl,
      merchant_allowlist: allowlist,
      merchant_pin_kind: opts.pinKind,
    },
  });

  // 2. Submit the consumer side → funding source + signed mandate (public; the
  //    token in the URL is the auth, so an extra bearer header is ignored).
  const submit = await client.post<Record<string, unknown>>(
    `/v1/consents/${encodeURIComponent(init.token)}/submit`,
    {
      consumer_id: opts.consumer,
      rail: opts.rail,
      provider_token: opts.providerToken ?? `${opts.rail}:${opts.consumer}`,
    },
  );

  if (opts.json) {
    json(submit);
    return;
  }

  const mandateId = (submit.mandate_id as string) ?? "(unknown)";
  success("mandate created");
  kv([
    ["mandate", mandateId],
    ["consumer", opts.consumer],
    ["agent", opts.agent],
    ["purpose", opts.purpose],
    ["allowlist", allowlist.join(", ")],
    ["per-tx cap", `${perTxMinor} ${opts.currency} (minor)`],
    ["total cap", `${capMinor} ${opts.currency} (minor)`],
    ["rail", opts.rail],
  ]);
  info(
    `Spend against it:\n  codespar spend --mandate ${mandateId} --payee ${allowlist[0]} --amount 1 --agent ${opts.agent}`,
  );
}
