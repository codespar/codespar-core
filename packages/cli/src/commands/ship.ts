import { readFile } from "node:fs/promises";
import { CodeSpar } from "@codespar/sdk";
import type { ShipArgs, ShipResult } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, success } from "../output.js";

interface ShipCommandOptions {
  apiKey: string;
  baseUrl: string;
  user?: string;
  input?: string;
  inputFile?: string;
  json?: boolean;
}

/**
 * Wraps `session.ship(args)`. Three actions over a unified envelope —
 * `label`, `quote`, `track`. Like charge, the meta-tool picks the
 * carrier so no `--server` is required.
 */
export async function shipCommand(opts: ShipCommandOptions): Promise<void> {
  const args = await resolveShipInput(opts);
  validateShipArgs(args);

  const userId = opts.user ?? "cli-user";
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const session = await cs.create(userId, { servers: [] });

  try {
    const result: ShipResult = await session.ship(args);

    if (opts.json) {
      json(result);
      return;
    }

    success(`ship ${result.id} → ${result.status}`);
    if (result.tracking_code) info(`Tracking: ${result.tracking_code}`);
    if (result.carrier) info(`Carrier: ${result.carrier}`);
    if (result.label_url) info(`Label URL: ${result.label_url}`);
    if (result.estimated_delivery) info(`ETA: ${result.estimated_delivery}`);
    if (typeof result.cost_minor === "number") info(`Cost (minor units): ${result.cost_minor}`);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await session.close();
  }
}

async function resolveShipInput(opts: ShipCommandOptions): Promise<ShipArgs> {
  if (opts.input && opts.inputFile) {
    throw new CliError("Pass either --input or --input-file, not both.");
  }
  if (!opts.input && !opts.inputFile) {
    throw new CliError(
      "ship requires --input '<json>' or --input-file <path>. " +
        'Example: --input \'{"action":"quote","origin":{"postal_code":"01310100"},"destination":{"postal_code":"22041011"},"items":[{"weight_g":500}]}\'',
    );
  }
  const raw = opts.inputFile
    ? await readFile(opts.inputFile, "utf-8")
    : (opts.input as string);
  const source = opts.inputFile ?? "--input";
  return parseJsonObject(raw, source) as unknown as ShipArgs;
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

function validateShipArgs(args: ShipArgs): void {
  if (!args.action || !["label", "quote", "track"].includes(args.action)) {
    throw new CliError("ship.action must be one of: label, quote, track.");
  }
  if (args.action === "track" && !args.tracking_code) {
    throw new CliError("ship.tracking_code is required when action=track.");
  }
  if ((args.action === "label" || args.action === "quote") && (!args.origin || !args.destination)) {
    throw new CliError("ship.origin and ship.destination are required when action=label|quote.");
  }
  if ((args.action === "label" || args.action === "quote") && (!args.items || args.items.length === 0)) {
    throw new CliError("ship.items must contain at least one item when action=label|quote.");
  }
}
