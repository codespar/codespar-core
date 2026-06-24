import { ApiClient } from "../api.js";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";

interface SpendCommandOptions {
  mandate: string;
  payee: string;
  amount: string;
  agent: string;
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

/**
 * Execute an agentic spend against a consumer mandate:
 *   POST /v1/consumers/mandates/:id/spend  { amount_minor, payee, agent_id }
 *
 * The SDK doesn't expose the consumer-mandate spend flow, so we hit the REST
 * endpoint directly. The backend reconstructs + signs the stored mandate,
 * runs the per-tx cap gate, and dispatches the rail by payee shape:
 *   - Pix key / BR Code  → Pix (pix-celcoin / PSP)
 *   - EVM address        → direct USDC transfer on Base (CDP)
 *   - http(s) URL        → x402 pay-per-call (USDC on Base, settled on-chain)
 */
export async function spendCommand(opts: SpendCommandOptions): Promise<void> {
  if (!opts.mandate) throw new CliError("--mandate <id> is required.");
  if (!opts.payee) {
    throw new CliError(
      "--payee is required (a Pix key, EVM address, or x402 resource URL).",
    );
  }
  const amountMinor = Number(opts.amount);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new CliError("--amount must be a positive integer in minor units (cents).");
  }
  if (!opts.agent) throw new CliError("--agent <id> is required.");

  const client = new ApiClient({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    project: opts.project,
  });

  const result = await client.post<Record<string, unknown>>(
    `/v1/consumers/mandates/${encodeURIComponent(opts.mandate)}/spend`,
    { amount_minor: amountMinor, payee: opts.payee, agent_id: opts.agent },
  );

  if (opts.json) {
    json(result);
    return;
  }
  success("spend executed");
  info("The on-chain tx / receipt is in the response below:");
  json(result);
}
