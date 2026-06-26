import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, kv, success, warn } from "../output.js";

interface TransferCommandOptions {
  from: string;
  to: string;
  amount: string;
  execute?: boolean;
  agent?: string;
  purpose?: string;
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

interface TransferResponse {
  consumer_id: string;
  route: string;
  converts: boolean;
  engine: string | null;
  executable?: boolean;
  executed?: boolean;
  transaction_id?: string;
  status?: string;
  pix_copy_paste?: string | null;
  destination_address?: string;
  source_debit?: { providerTxId: string; status: string; moneyMoved: boolean } | null;
  source_debit_error?: string | null;
  money_moved?: boolean;
  settle_via?: string;
  from?: { currency: string; rail: string | null; amount_minor: number; cap_available_minor: number };
  to?: { currency: string; rail: string | null };
  note?: string;
}

/**
 * Move value between two slots of a consumer's unified wallet:
 *   POST /v1/consumers/:id/wallet/transfer
 *
 * Caps + balances are per-currency with NO synthetic FX, so a cross-currency
 * move is a real fiat<>stablecoin trade settled through the ramp at the real
 * quoted rate. Without --execute this PLANS the move (route + whether it
 * converts); with --execute it runs the ramp legs (real money) and the USDC
 * credit settles async (poll the printed settle_via path).
 */
export async function transferCommand(consumerId: string, opts: TransferCommandOptions): Promise<void> {
  if (!consumerId) throw new CliError("a consumer id is required: codespar transfer <consumer> --from BRL --to USDC --amount <minor>");
  if (!opts.from) throw new CliError("--from <currency> is required (e.g. BRL).");
  if (!opts.to) throw new CliError("--to <currency> is required (e.g. USDC).");
  const amountMinor = Number(opts.amount);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new CliError("--amount must be a positive integer in minor units (cents).");
  }

  const client = new ApiClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, project: opts.project });

  const body: Record<string, unknown> = {
    from_currency: opts.from,
    to_currency: opts.to,
    amount_minor: amountMinor,
  };
  if (opts.execute) body.execute = true;
  if (opts.agent) body.agent_id = opts.agent;
  if (opts.purpose) body.purpose = opts.purpose;

  const res = await client.post<TransferResponse>(
    `/v1/consumers/${encodeURIComponent(consumerId)}/wallet/transfer`,
    body,
  );

  if (opts.json) {
    json(res);
    return;
  }

  // Execution result.
  if (res.executed) {
    success(`transfer executed (${res.route})`);
    const rows: Array<[string, string]> = [
      ["consumer", res.consumer_id],
      ["route", `${res.route}${res.converts ? ` via ${res.engine} (real rate, no FX)` : ""}`],
      ["onramp tx", res.transaction_id ?? "-"],
      ["status", res.status ?? "-"],
      ["destination", res.destination_address ?? "-"],
    ];
    if (res.source_debit) {
      rows.push(["source debit", `${res.source_debit.providerTxId} (${res.source_debit.status})`]);
    }
    kv(rows);
    if (res.source_debit_error) {
      warn(`source debit not completed: ${res.source_debit_error}`);
    }
    if (res.settle_via) {
      info(`USDC credit settles async — poll: codespar wallet ${res.consumer_id} (or GET ${res.settle_via})`);
    }
    return;
  }

  // Plan result.
  info(`Transfer plan for ${res.consumer_id}:`);
  kv([
    ["route", res.route],
    ["converts", res.converts ? `yes — via ${res.engine} at the real rate (no FX)` : "no"],
    ["executable", res.executable ? "yes" : "not wired yet"],
    ["from", res.from ? `${res.from.currency}/${res.from.rail ?? "-"} (cap left ${res.from.cap_available_minor})` : `${opts.from}`],
    ["to", res.to ? `${res.to.currency}/${res.to.rail ?? "-"}` : `${opts.to}`],
    ["amount", `${amountMinor} (minor)`],
  ]);
  if (res.note) info(res.note);
  if (res.executable) {
    info(`Run it for real:\n  codespar transfer ${res.consumer_id} --from ${opts.from} --to ${opts.to} --amount ${amountMinor} --execute`);
  }
}
