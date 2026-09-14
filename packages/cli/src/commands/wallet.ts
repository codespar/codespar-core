import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, table } from "../output.js";

interface WalletCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

/**
 * Show a consumer's unified wallet, rolled up per currency:
 *   GET /v1/consumers/:id/wallet
 *
 * A multi-slot mandate is a wallet with one slot per (currency, rail). Caps are
 * per-currency, so each currency's spend authority is listed side by side with
 * no FX between them — a BRL Pix line and a USDC x402 line, each with its own
 * ceiling. `available = authorized - spent`, NOT floored at zero: a slot whose
 * settled debits exceed its cap answers a negative value and `overspent: true`,
 * which the table prints next to the amount so a minus sign is not the only signal.
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

  const wallet = await client.get("/v1/consumers/{id}/wallet", {
    path: { id: consumerId },
  });

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
      cur.overspent ? `${cur.available_minor} (overspent)` : String(cur.available_minor),
    ]),
  );
  info(
    "Amounts are in minor units (cents / micro-USDC). Caps are per-currency, no FX. A negative available marked (overspent) means settled debits exceed the cap.",
  );
}
