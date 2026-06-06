import { CodeSpar } from "@codespar/sdk";
import type { ChargeArgs, ChargeResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";
import { resolveMetaInput } from "./meta-input.js";

const EXAMPLE =
  '{"amount":50,"currency":"BRL","method":"pix","description":"Test","buyer":{"name":"Ana"}}';

interface ChargeCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  user?: string;
  input?: string;
  inputFile?: string;
  json?: boolean;
}

/**
 * Wraps `session.charge(args)`. The meta-tool router picks the rail,
 * so no `--server` is needed — we open the session with `servers: []`.
 * Args are read from `--input` (JSON string) or `--input-file` (path).
 */
export async function chargeCommand(opts: ChargeCommandOptions): Promise<void> {
  const args = (await resolveMetaInput(opts, "charge", EXAMPLE)) as unknown as ChargeArgs;
  validateChargeArgs(args);

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, projectId: opts.project });
  const session = await cs.create(userId, { servers: [] });

  try {
    const result: ChargeResult = await session.charge(args);

    if (opts.json) {
      json(result);
      return;
    }

    success(`charge ${result.id} → ${result.status}`);
    info(
      `Amount: ${result.amount} ${result.currency}  ·  method: ${result.method}`,
    );
    if (result.charge_url) info(`Charge URL: ${result.charge_url}`);
    if (result.pix_qr_code) info(`Pix QR (truncated): ${result.pix_qr_code.slice(0, 40)}...`);
    if (result.pix_copy_paste) {
      info("Pix copy-paste:");
      process.stdout.write(`\n${result.pix_copy_paste}\n\n`);
    }
  } finally {
    await session.close();
  }
}

function validateChargeArgs(args: ChargeArgs): void {
  if (typeof args.amount !== "number") {
    throw new CliError("charge.amount must be a number (major units).");
  }
  if (!args.currency || typeof args.currency !== "string") {
    throw new CliError("charge.currency is required (e.g. BRL).");
  }
  if (!args.method) {
    throw new CliError("charge.method is required (pix | boleto | card).");
  }
  if (!args.buyer || typeof args.buyer !== "object" || !args.buyer.name) {
    throw new CliError("charge.buyer.name is required.");
  }
  if (!args.description) {
    throw new CliError("charge.description is required.");
  }
}
