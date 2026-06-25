import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, table } from "../output.js";

interface WalletCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

interface WalletCurrency {
  currency: string;
  rail: string | null;
  authorized_minor: number;
  spent_minor: number;
  available_minor: number;
  funding_source_ids: string[];
  mandate_ids: string[];
}

interface WalletResponse {
  consumer_id: string;
  currencies: WalletCurrency[];
}

/**
 * Show a consumer's unified wallet, rolled up per currency:
 *   GET /v1/consumers/:id/wallet
 *
 * A multi-slot mandate is a wallet with one slot per (currency, rail). Caps are
 * per-currency, so each currency's spend authority is listed side by side with
 * no FX between them — a BRL Pix line and a USDC x402 line, each with its own
 * ceiling. `available = authorized - spent`.
 */
export async function walletCommand(
  consumerId: string,
  opts: WalletCommandOptions,
): Promise<void> {
  if (!consumerId) {
    throw new CliError("a consumer id is required: codespar wallet <consumer>");
  }

  const client = new ApiClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    project: opts.project,
  });

  const wallet = await client.get<WalletResponse>(
    `/v1/consumers/${encodeURIComponent(consumerId)}/wallet`,
  );

  if (opts.json) {
    json(wallet);
    return;
  }

  if (wallet.currencies.length === 0) {
    info(
      `No active mandate slots for consumer ${consumerId}.\n  Create one with: codespar mandate create --consumer ${consumerId} --slot USDC:usdc-onchain:100:100 ...`,
    );
    return;
  }

  table(
    ["currency", "rail", "authorized", "spent", "available"],
    wallet.currencies.map((cur) => [
      cur.currency,
      cur.rail ?? "-",
      String(cur.authorized_minor),
      String(cur.spent_minor),
      String(cur.available_minor),
    ]),
  );
  info("Amounts are in minor units (cents / micro-USDC). Caps are per-currency, no FX.");
}
