import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, kv, success } from "../output.js";

interface MandateSlotInput {
  currency: string;
  rail: string;
  cap_minor: number;
  per_tx_cap_minor: number;
}

interface MandateCreateOptions {
  consumer: string;
  agent: string;
  purpose: string;
  /** Comma-separated allowlist of payees (x402 URL / EVM address / Pix key). */
  payee: string;
  /** Legacy single-currency caps. Ignored when --slot is given. */
  cap?: string;
  perTxCap?: string;
  currency: string;
  rail: string;
  ttl: string;
  pinKind: string;
  /** Repeatable wallet slot spec "CURRENCY:RAIL:CAP:PER_TX_CAP" — present for a
   *  multi-currency (unified) mandate; absent for the legacy single-currency one. */
  slot?: string[];
  providerToken?: string;
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

/**
 * Parse `--slot CURRENCY:RAIL:CAP:PER_TX_CAP` specs into the intent.slots shape.
 * Rails never contain a colon (e.g. usdc-onchain, pix-celcoin), so a 4-way
 * split on `:` is unambiguous. Caps are per-currency minor units; no FX.
 */
function parseSlots(specs: string[]): MandateSlotInput[] {
  return specs.map((spec) => {
    const parts = spec.split(":");
    if (parts.length !== 4) {
      throw new CliError(
        `--slot must be CURRENCY:RAIL:CAP:PER_TX_CAP (e.g. USDC:usdc-onchain:100:100). Got: ${spec}`,
      );
    }
    const [currency, rail, capStr, perTxStr] = parts;
    if (!currency || !rail) {
      throw new CliError(`--slot ${spec}: currency and rail are required.`);
    }
    const cap_minor = Number(capStr);
    const per_tx_cap_minor = Number(perTxStr);
    if (!Number.isInteger(cap_minor) || cap_minor <= 0) {
      throw new CliError(`--slot ${spec}: cap must be a positive integer (minor units).`);
    }
    if (!Number.isInteger(per_tx_cap_minor) || per_tx_cap_minor <= 0) {
      throw new CliError(`--slot ${spec}: per-tx cap must be a positive integer (minor units).`);
    }
    return { currency, rail, cap_minor, per_tx_cap_minor };
  });
}

/**
 * Create a consumer mandate — the agent's "allowance / wallet" — end to end.
 *
 * Runs the directed-pay consent flow the way an org backend would:
 *   1. POST /v1/consents/init      (authed) mints a one-shot token carrying the
 *      intent (purpose, caps, currency/slots, allowlist).
 *   2. POST /v1/consents/:token/submit (public) provisions the consumer funding
 *      source(s) and signs the mandate with the consumer secret.
 *
 * Two shapes:
 *   - Legacy single-currency: --cap / --per-tx-cap / --currency / --rail.
 *   - Unified multi-slot wallet: one or more --slot CURRENCY:RAIL:CAP:PER_TX_CAP.
 *     The spend routes a payee to its currency's slot and enforces THAT slot's
 *     caps (per-currency, no FX). The submit provisions one funding source per
 *     slot; the consumer's derived wallet (usdc-onchain) / Celcoin account
 *     (pix-celcoin) stays the same across mandates.
 *
 * Prints the mandate id you then hand to `codespar spend`, and (multi-slot) the
 * `codespar wallet` view.
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

  const ttl = Number(opts.ttl);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new CliError("--ttl must be a positive integer (seconds).");
  }

  const slots = (opts.slot ?? []).length > 0 ? parseSlots(opts.slot!) : undefined;

  // The intent's top-level cap/currency mirror the primary (first) slot for a
  // multi-slot mandate; for the legacy path they come from --cap / --currency.
  let primaryCapMinor: number;
  let primaryPerTxMinor: number;
  let primaryCurrency: string;
  if (slots) {
    primaryCapMinor = slots[0]!.cap_minor;
    primaryPerTxMinor = slots[0]!.per_tx_cap_minor;
    primaryCurrency = slots[0]!.currency;
  } else {
    primaryCapMinor = Number(opts.cap);
    primaryPerTxMinor = Number(opts.perTxCap);
    primaryCurrency = opts.currency;
    if (!Number.isInteger(primaryCapMinor) || primaryCapMinor <= 0) {
      throw new CliError(
        "--cap must be a positive integer in minor units (or use --slot for a multi-currency mandate).",
      );
    }
    if (!Number.isInteger(primaryPerTxMinor) || primaryPerTxMinor <= 0) {
      throw new CliError(
        "--per-tx-cap must be a positive integer in minor units (or use --slot).",
      );
    }
  }

  const client = new ApiClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    project: opts.project,
  });

  // 1. Mint the consent token (authed). slots ride along in the intent.
  const intent: Record<string, unknown> = {
    purpose: opts.purpose,
    cap_minor: primaryCapMinor,
    per_tx_cap_minor: primaryPerTxMinor,
    currency: primaryCurrency,
    mandate_ttl_seconds: ttl,
    merchant_allowlist: allowlist,
    merchant_pin_kind: opts.pinKind,
  };
  if (slots) intent.slots = slots;

  const init = await client.post<{ token: string; expires_at: string }>("/v1/consents/init", {
    agent_id: opts.agent,
    intent,
  });

  // 2. Submit the consumer side → funding source(s) + signed mandate (public;
  //    the token in the URL is the auth, so an extra bearer header is ignored).
  //    For a multi-slot mandate the backend derives one funding source per slot
  //    from intent.slots; the rail/provider_token here only satisfy the submit
  //    schema (a valid rail value), so the --rail default is fine.
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

  if (slots) {
    success("multi-slot mandate created");
    kv([
      ["mandate", mandateId],
      ["consumer", opts.consumer],
      ["agent", opts.agent],
      ["purpose", opts.purpose],
      ["allowlist", allowlist.join(", ")],
      [
        "slots",
        slots
          .map((s) => `${s.currency}/${s.rail} cap ${s.cap_minor} (per-tx ${s.per_tx_cap_minor})`)
          .join("  |  "),
      ],
    ]);
    info(
      `One signature, ${slots.length} currencies — caps are per-currency (no FX).\n  See the wallet:  codespar wallet ${opts.consumer}\n  Spend:           codespar spend --mandate ${mandateId} --payee ${allowlist[0]} --amount 1 --agent ${opts.agent}`,
    );
    return;
  }

  success("mandate created");
  kv([
    ["mandate", mandateId],
    ["consumer", opts.consumer],
    ["agent", opts.agent],
    ["purpose", opts.purpose],
    ["allowlist", allowlist.join(", ")],
    ["per-tx cap", `${primaryPerTxMinor} ${primaryCurrency} (minor)`],
    ["total cap", `${primaryCapMinor} ${primaryCurrency} (minor)`],
    ["rail", opts.rail],
  ]);
  info(
    `Spend against it:\n  codespar spend --mandate ${mandateId} --payee ${allowlist[0]} --amount 1 --agent ${opts.agent}`,
  );
}
