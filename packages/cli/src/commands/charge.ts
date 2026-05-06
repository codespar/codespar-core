import { readFile } from "node:fs/promises";
import { CodeSpar } from "@codespar/sdk";
import type { ChargeArgs, ChargeResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";

interface ChargeCommandOptions {
  apiKey: string;
  baseUrl: string;
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
  const args = await resolveChargeInput(opts);
  validateChargeArgs(args);

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
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
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await session.close();
  }
}

async function resolveChargeInput(opts: ChargeCommandOptions): Promise<ChargeArgs> {
  if (opts.input && opts.inputFile) {
    throw new CliError("Pass either --input or --input-file, not both.");
  }
  if (!opts.input && !opts.inputFile) {
    throw new CliError(
      "charge requires --input '<json>' or --input-file <path>. " +
        'Example: --input \'{"amount":50,"currency":"BRL","method":"pix","description":"Test","buyer":{"name":"Ana"}}\'',
    );
  }
  const raw = opts.inputFile
    ? await readFile(opts.inputFile, "utf-8")
    : (opts.input as string);
  const source = opts.inputFile ?? "--input";
  return parseJsonObject(raw, source) as unknown as ChargeArgs;
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError(`${source} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${source} is not valid JSON: ${(err as Error).message}`);
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
