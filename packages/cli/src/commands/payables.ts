/**
 * `codespar payables files|batches`: pay documents and batches.
 *
 * These go through the SDK's `cs.payables` facade, not through a path
 * written here: the facade is the typed client of the
 * `/v1/payables/files` and `/v1/payables/batches` contract, shared with
 * the Python SDK and the MCP server, and uploading a file needs the
 * multipart body the facade builds.
 *
 * Amounts are minor units (cents), like `codespar spend --amount`.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  CodeSpar,
  payableBatchFromError,
  type PayableBatch,
  type PayableFile,
  type PayableItemInput,
  type PayableItemUpdate,
} from "@codespar/sdk";

import { CliError } from "../config.js";
import { info, json, kv, success, table } from "../output.js";

export interface PayablesAuth {
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

function client(auth: PayablesAuth): CodeSpar {
  return new CodeSpar({ apiKey: auth.apiKey, baseUrl: auth.baseUrl, projectId: auth.project });
}

const ITEM_KEYS: Record<string, keyof PayableItemInput> = {
  pix_key: "pixKey",
  boleto_line: "boletoLine",
  br_code: "brCode",
  amount_minor: "amountMinor",
  description: "description",
  reference: "reference",
};

function minorUnits(raw: string, flag: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive integer in minor units (cents), got "${raw}".`);
  }
  return n;
}

/**
 * One `--item`: a JSON object with the wire's snake_case keys, or
 * `key=value` pairs separated by commas (`pix_key=a@b.com,amount_minor=5000`).
 * Use the JSON form when a value carries a comma.
 */
export function parseItemSpec(spec: string): PayableItemInput {
  let pairs: Array<[string, unknown]>;
  const trimmed = spec.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new CliError(`--item is not valid JSON: ${spec}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError("--item JSON must be an object.");
    }
    pairs = Object.entries(parsed as Record<string, unknown>);
  } else {
    pairs = trimmed.split(",").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new CliError(`--item expects key=value pairs, got "${pair}".`);
      return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] as [string, string];
    });
  }

  const item: PayableItemInput = {};
  for (const [key, value] of pairs) {
    const field = ITEM_KEYS[key];
    if (!field) {
      throw new CliError(
        `--item key "${key}" is not one of ${Object.keys(ITEM_KEYS).join(", ")}.`,
      );
    }
    if (field === "amountMinor") item.amountMinor = minorUnits(String(value), "amount_minor");
    else (item as Record<string, unknown>)[field] = String(value);
  }
  const carriers = [item.pixKey, item.boletoLine, item.brCode].filter(Boolean).length;
  if (carriers !== 1) {
    throw new CliError("--item needs exactly one of pix_key, boleto_line or br_code.");
  }
  if (item.pixKey && item.amountMinor === undefined) {
    throw new CliError("--item with a pix_key needs amount_minor: a Pix key never sets the amount.");
  }
  return item;
}

async function uploadPath(cs: CodeSpar, path: string): Promise<PayableFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  return cs.payables.files.upload(bytes, { filename: basename(path) });
}

function brl(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return "-";
  return `R$ ${(minor / 100).toFixed(2)}`;
}

/** Summary plus one row per item: destination as the rail resolved it, amount, result. */
export function renderBatch(batch: PayableBatch): void {
  kv([
    ["batch", batch.batch_id],
    ["status", batch.status],
    ["version", String(batch.version)],
    ["list_hash", batch.list_hash],
    [
      "total",
      `${brl(batch.totals.amount_minor)} (${batch.totals.payable_items} of ${batch.totals.items} items, ${batch.totals.excluded} excluded)`,
    ],
  ]);
  if (batch.items.length === 0) return;
  process.stdout.write("\n");
  table(
    ["#", "item", "state", "to", "amount", "result"],
    batch.items.map((item) => [
      String(item.position),
      item.item_id,
      item.missing.length ? `${item.state} (needs ${item.missing.join(", ")})` : item.state,
      item.destination
        ? [item.destination.beneficiary_name, item.destination.display].filter(Boolean).join(" ")
        : "-",
      brl(item.amount_minor),
      item.payment
        ? item.payment.refusal
          ? `${item.payment.state}: ${item.payment.refusal.code}`
          : item.payment.state
        : "-",
    ]),
  );
}

function emit(batch: PayableBatch, auth: PayablesAuth): void {
  if (auth.json) json(batch);
  else renderBatch(batch);
}

export async function payablesFilesUploadCommand(path: string, auth: PayablesAuth): Promise<void> {
  const file = await uploadPath(client(auth), path);
  if (auth.json) {
    json(file);
    return;
  }
  success(`${file.file_id}: ${file.items_found} item(s) found, ${file.unresolved} need a complement`);
  kv([
    ["kind", file.kind],
    ["size", `${file.size_bytes} bytes`],
    ["sha256", file.sha256],
    ["expires", file.expires_at],
  ]);
}

export interface BatchCreateOptions extends PayablesAuth {
  file: string[];
  fileId: string[];
  item: string[];
  idempotencyKey?: string;
}

export async function payablesBatchCreateCommand(opts: BatchCreateOptions): Promise<void> {
  const items = opts.item.map(parseItemSpec);
  if (opts.file.length + opts.fileId.length + items.length === 0) {
    throw new CliError("Pass at least one --file, --file-id or --item.");
  }
  const cs = client(opts);
  const fileIds = [...opts.fileId];
  for (const path of opts.file) {
    const file = await uploadPath(cs, path);
    if (!opts.json) info(`${basename(path)} → ${file.file_id} (${file.items_found} item(s))`);
    fileIds.push(file.file_id);
  }
  const batch = await cs.payables.batches.create(
    {
      ...(fileIds.length ? { fileIds } : {}),
      ...(items.length ? { items } : {}),
      source: "cli",
    },
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
  );
  emit(batch, opts);
}

export async function payablesBatchGetCommand(batchId: string, auth: PayablesAuth): Promise<void> {
  emit(await client(auth).payables.batches.get(batchId), auth);
}

export interface UpdateItemOptions extends PayablesAuth {
  expectedVersion: string;
  amount?: string;
  pixKey?: string;
  boletoLine?: string;
  brCode?: string;
  description?: string;
  exclude?: boolean;
  include?: boolean;
}

function version(raw: string, flag: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n)) {
    throw new CliError(`${flag} must be the batch's integer version, got "${raw}".`);
  }
  return n;
}

export async function payablesBatchUpdateItemCommand(
  batchId: string,
  itemId: string,
  opts: UpdateItemOptions,
): Promise<void> {
  if (opts.exclude && opts.include) throw new CliError("Pass --exclude or --include, not both.");
  const update: PayableItemUpdate = {
    expectedVersion: version(opts.expectedVersion, "--expected-version"),
    ...(opts.amount !== undefined ? { amountMinor: minorUnits(opts.amount, "--amount") } : {}),
    ...(opts.pixKey !== undefined ? { pixKey: opts.pixKey } : {}),
    ...(opts.boletoLine !== undefined ? { boletoLine: opts.boletoLine } : {}),
    ...(opts.brCode !== undefined ? { brCode: opts.brCode } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.exclude ? { excluded: true } : opts.include ? { excluded: false } : {}),
  };
  if (Object.keys(update).length === 1) {
    throw new CliError(
      "Nothing to change: pass --amount, --pix-key, --boleto-line, --br-code, --description, --exclude or --include.",
    );
  }
  emit(await client(opts).payables.batches.updateItem(batchId, itemId, update), opts);
}

export interface PayOptions extends PayablesAuth {
  batchVersion: string;
  listHash: string;
  mandate?: string;
  idempotencyKey?: string;
}

export async function payablesBatchPayCommand(batchId: string, opts: PayOptions): Promise<void> {
  if (!opts.listHash) throw new CliError("--list-hash is required: it is the list you confirm.");
  let batch: PayableBatch;
  try {
    batch = await client(opts).payables.batches.pay(
      batchId,
      {
        version: version(opts.batchVersion, "--batch-version"),
        listHash: opts.listHash,
        ...(opts.mandate ? { mandateId: opts.mandate } : {}),
      },
      opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined,
    );
  } catch (err) {
    const current = payableBatchFromError(err);
    if (current && !opts.json) {
      // The list changed since it was read: show the one that would be paid
      // now, and leave the new confirmation to the person.
      renderBatch(current);
      process.stdout.write("\n");
      info(
        `The list changed. Review it, then confirm with --batch-version ${current.version} --list-hash ${current.list_hash}.`,
      );
    }
    throw err;
  }
  emit(batch, opts);
}
