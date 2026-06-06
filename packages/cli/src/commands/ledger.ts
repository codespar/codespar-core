import { CodeSpar } from "@codespar/sdk";
import type { LedgerArgs, LedgerResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";
import { resolveMetaInput } from "./meta-input.js";

interface LedgerCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  user?: string;
  input?: string;
  inputFile?: string;
  json?: boolean;
}

const EXAMPLE =
  '{"action":"entry","asset":"BRL","source":[{"account":"@external/BRL","amount":12500}],"destination":[{"account":"@wallet/user_1","amount":12500}],"description":"top-up"}';

/**
 * Wraps `session.ledger(args)` — post a double-entry transaction, read an
 * account balance, or create an account against the tenant's self-hosted
 * Midaz ledger. The meta-tool router resolves the rail, so no `--server`.
 */
export async function ledgerCommand(opts: LedgerCommandOptions): Promise<void> {
  const args = (await resolveMetaInput(opts, "ledger", EXAMPLE)) as unknown as LedgerArgs;
  validateLedgerArgs(args);

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    projectId: opts.project,
  });
  const session = await cs.create(userId, { servers: [] });

  try {
    const result: LedgerResult = await session.ledger(args);

    if (opts.json) {
      json(result);
      return;
    }

    success(`ledger ${args.action} → ${result.status ?? "ok"}`);
    if (result.id) info(`Id: ${result.id}`);
    if (result.account_id) info(`Account: ${result.account_id}`);
    if (result.alias) info(`Alias: ${result.alias}`);
    if (result.balances !== undefined) {
      info("Balances:");
      process.stdout.write(JSON.stringify(result.balances, null, 2) + "\n");
    }
  } finally {
    await session.close();
  }
}

export function validateLedgerArgs(args: LedgerArgs): void {
  if (!args.action || !["entry", "balance", "account"].includes(args.action)) {
    throw new CliError("ledger.action must be one of: entry, balance, account.");
  }
  if (args.action === "entry") {
    if (!args.asset) throw new CliError("ledger.asset is required when action=entry.");
    if (!args.source || args.source.length === 0) {
      throw new CliError("ledger.source must be a non-empty array when action=entry.");
    }
    if (!args.destination || args.destination.length === 0) {
      throw new CliError("ledger.destination must be a non-empty array when action=entry.");
    }
  }
  if (args.action === "balance" && !args.account) {
    throw new CliError("ledger.account (id) is required when action=balance.");
  }
  if (args.action === "account" && !args.asset) {
    throw new CliError("ledger.asset is required when action=account.");
  }
}
