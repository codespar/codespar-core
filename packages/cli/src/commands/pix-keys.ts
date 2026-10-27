/**
 * `codespar pix-keys list|register|delete`: the Pix keys of a consumer's own
 * account, through the SDK's `cs.wallet.pixKeys` facade (the typed client of
 * `/v1/consumers/:consumerId/pix-keys`, shared with the Python SDK).
 *
 * `delete` sends nothing without `--confirm`: the command prints the
 * consequence sentence and exits non-zero, so a script cannot delete a key by
 * omission. The derived `codespar consumers` group still carries the generic
 * spelling of the same three routes (`-i` JSON bodies); this group adds the
 * explicit type, the confirmation and a readable table.
 */

import { CodeSpar, PixKeyDeleteNotConfirmedError, type PixKeyType } from "@codespar/sdk";

import { CliError } from "../config.js";
import { json, kv, success, table } from "../output.js";

export interface PixKeysAuth {
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

const KEY_TYPES: readonly PixKeyType[] = ["EVP", "CPF", "CNPJ", "EMAIL", "PHONE"];

function client(auth: PixKeysAuth): CodeSpar {
  return new CodeSpar({ apiKey: auth.apiKey, baseUrl: auth.baseUrl, projectId: auth.project });
}

/** `--type`, upper-cased, from the route's closed set; EVP (a random key) when absent. */
export function parseKeyType(raw: string | undefined): PixKeyType {
  if (raw === undefined || raw.trim() === "") return "EVP";
  const upper = raw.trim().toUpperCase();
  const found = KEY_TYPES.find((t) => t === upper);
  if (!found) throw new CliError(`--type must be one of ${KEY_TYPES.join(", ")}, got "${raw}".`);
  return found;
}

export interface PixKeysListOptions extends PixKeysAuth {
  consumer: string;
}

export async function pixKeysListCommand(opts: PixKeysListOptions): Promise<void> {
  const out = await client(opts).wallet.pixKeys.list(opts.consumer);
  if (opts.json) {
    json(out);
    return;
  }
  kv([
    ["consumer", opts.consumer],
    ["account", out.account_masked],
    ["keys", String(out.count)],
  ]);
  if (out.keys.length === 0) return;
  process.stdout.write("\n");
  table(
    ["type", "key"],
    out.keys.map((k) => [k.key_type, k.key]),
  );
}

export interface PixKeysRegisterOptions extends PixKeysAuth {
  consumer: string;
  type?: string;
  key?: string;
}

export async function pixKeysRegisterCommand(opts: PixKeysRegisterOptions): Promise<void> {
  const keyType = parseKeyType(opts.type);
  if (keyType !== "EVP" && !opts.key) {
    throw new CliError(`--type ${keyType} needs --key <value>; only EVP (a random key) takes none.`);
  }
  if (keyType === "EVP" && opts.key) {
    throw new CliError("--key is not read for a random key (EVP): the bank mints it. Pass --type for a key with a value.");
  }
  const out = await client(opts).wallet.pixKeys.register(opts.consumer, { keyType, ...(opts.key ? { key: opts.key } : {}) });
  if (opts.json) {
    json(out);
    return;
  }
  success(`${out.key_type} key registered on account ${out.account_masked}${out.reconciled ? " (read back from the account's list)" : ""}`);
  kv([["key", out.key]]);
}

export interface PixKeysDeleteOptions extends PixKeysAuth {
  consumer: string;
  confirm?: boolean;
}

export async function pixKeysDeleteCommand(key: string, opts: PixKeysDeleteOptions): Promise<void> {
  let out;
  try {
    out = await client(opts).wallet.pixKeys.delete(opts.consumer, key, { confirm: opts.confirm === true });
  } catch (err) {
    if (err instanceof PixKeyDeleteNotConfirmedError) {
      throw new CliError(`${err.consequence} Pass --confirm to delete it. Nothing was sent.`);
    }
    throw err;
  }
  if (opts.json) {
    json(out);
    return;
  }
  success(`key deleted from account ${out.account_masked}`);
  kv([["key", out.key]]);
}
