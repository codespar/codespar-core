/**
 * `codespar_payables` as an MCP tool: pay documents and batches through
 * the SDK's `cs.payables` facade (`/v1/payables/files`,
 * `/v1/payables/batches`).
 *
 * `upload` reads a local `path`, so it exists only on this stdio server,
 * which runs on the person's machine; the hosted MCP takes a `file_id`
 * uploaded with `POST /v1/payables/files`. Nothing here fetches a URL.
 *
 * What reaches the model is ids, counts, masked destinations and amounts:
 * the batch is projected before it is returned, and item descriptions,
 * which can carry text read from a document, are left out.
 */
import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { PayableBatch, PayableFile, PayableItemInput, Payables } from "@codespar/sdk";
import type { McpToolDefinition } from "./shop-purchase-tools.js";

export const PAYABLES_TOOL_NAME = "codespar_payables";

const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".csv", ".xlsx"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "One charge stated directly. Exactly one of pix_key, boleto_line, br_code.",
  properties: {
    pix_key: { type: "string", description: "Pix key. Needs amount_minor: a key never sets the amount." },
    boleto_line: { type: "string", description: "Boleto digitable line." },
    br_code: { type: "string", description: "Pix copia-e-cola (BR Code)." },
    amount_minor: { type: "integer", minimum: 1, description: "Amount in cents, as the person stated it." },
    description: { type: "string" },
    reference: { type: "string", description: "Your own reference; part of the item identity." },
  },
} as const;

/** The tool definition. `withUpload: false` is the shape a server without local files would list. */
export function payablesToolDefinition(withUpload = true): McpToolDefinition {
  const actions = withUpload
    ? ["upload", "create_batch", "get", "update_item", "pay"]
    : ["create_batch", "get", "update_item", "pay"];
  return {
    name: PAYABLES_TOOL_NAME,
    description:
      "Pay documents and batches (boleto, Pix key, Pix QR/BR Code, CSV/XLSX lists). " +
      (withUpload ? "action=upload reads a local file (path) and returns its file_id and how many charges it holds; " : "") +
      "action=create_batch builds a batch from file_ids and/or stated items; action=get reads it; " +
      "action=update_item complements or corrects one item (expected_version) or excludes it; " +
      "action=pay confirms the exact list (version + list_hash) and pays it, each item with its own result. " +
      "Destinations shown are the ones the rail resolved (beneficiary name, masked document), never the extracted text. " +
      "Only pay a list the person reviewed and confirmed; a changed list is refused and must be confirmed again.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: actions },
        ...(withUpload
          ? {
              path: {
                type: "string",
                description: "upload: a local PDF, PNG, JPEG, WEBP, CSV or XLSX file, at most 10 MB.",
              },
            }
          : {}),
        file_ids: { type: "array", maxItems: 20, items: { type: "string" }, description: "create_batch: uploaded files." },
        items: { type: "array", maxItems: 500, items: ITEM_SCHEMA, description: "create_batch: stated charges." },
        batch_id: { type: "string", description: "get, update_item, pay." },
        item_id: { type: "string", description: "update_item." },
        expected_version: { type: "integer", description: "update_item: the batch version you read." },
        amount_minor: { type: "integer", minimum: 1, description: "update_item: amount in cents." },
        pix_key: { type: "string", description: "update_item." },
        boleto_line: { type: "string", description: "update_item." },
        br_code: { type: "string", description: "update_item." },
        excluded: { type: "boolean", description: "update_item: true leaves the item out, false puts it back." },
        version: { type: "integer", description: "pay: the batch version the person confirmed." },
        list_hash: { type: "string", description: "pay: the list_hash the person confirmed." },
        mandate_id: { type: "string", description: "pay: the mandate that authorizes it." },
        idempotency_key: { type: "string", description: "create_batch: the same key returns the same batch." },
      },
    },
  };
}

export function isPayablesTool(name: string): boolean {
  return name === PAYABLES_TOOL_NAME;
}

/** The batch as the model may see it: no description, no document text. */
export function projectBatch(batch: PayableBatch): Record<string, unknown> {
  return {
    batch_id: batch.batch_id,
    status: batch.status,
    version: batch.version,
    list_hash: batch.list_hash,
    currency: batch.currency,
    totals: batch.totals,
    confirmation: batch.confirmation
      ? { version: batch.confirmation.version, list_hash: batch.confirmation.list_hash, confirmed_at: batch.confirmation.confirmed_at }
      : null,
    items: batch.items.map((item) => ({
      item_id: item.item_id,
      position: item.position,
      origin: { file_id: item.origin.file_id, kind: item.origin.kind },
      rail: item.rail,
      state: item.state,
      missing: item.missing,
      destination: item.destination,
      amount_minor: item.amount_minor,
      amount_source: item.amount_source,
      checks: item.checks.map((c) => ({ code: c.code, status: c.status, ...(c.simulated ? { simulated: true } : {}) })),
      payment: item.payment
        ? {
            state: item.payment.state,
            attempt_id: item.payment.attempt_id,
            receipt_id: item.payment.receipt_id ?? null,
            refusal: item.payment.refusal ? { code: item.payment.refusal.code } : null,
          }
        : null,
    })),
  };
}

function projectFile(file: PayableFile): Record<string, unknown> {
  return {
    file_id: file.file_id,
    kind: file.kind,
    size_bytes: file.size_bytes,
    items_found: file.items_found,
    unresolved: file.unresolved,
    expires_at: file.expires_at,
  };
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`${field} is required`);
  return v;
}

function int(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${field} must be an integer`);
  return v;
}

function optional<T>(v: unknown, check: (x: unknown) => x is T): T | undefined {
  return v === undefined || v === null ? undefined : check(v) ? v : undefined;
}

const isString = (x: unknown): x is string => typeof x === "string";
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

function items(raw: unknown): PayableItemInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("items must be an array");
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const item: PayableItemInput = {};
    if (isString(o.pix_key)) item.pixKey = o.pix_key;
    if (isString(o.boleto_line)) item.boletoLine = o.boleto_line;
    if (isString(o.br_code)) item.brCode = o.br_code;
    if (isInt(o.amount_minor)) item.amountMinor = o.amount_minor;
    if (isString(o.description)) item.description = o.description;
    if (isString(o.reference)) item.reference = o.reference;
    return item;
  });
}

/**
 * Read a local file for `upload`, refusing what the API would refuse anyway
 * (type by extension, size) before any byte leaves the machine.
 */
async function readLocalFile(path: string): Promise<{ bytes: Buffer; filename: string }> {
  const ext = extname(path).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new Error(`upload accepts ${ACCEPTED_EXTENSIONS.join(", ")} files only`);
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error("upload path is not a regular file");
  if (info.size > MAX_FILE_BYTES) throw new Error("upload file is larger than 10 MB");
  const handle = await open(path, "r");
  try {
    return { bytes: await handle.readFile(), filename: basename(path) };
  } finally {
    await handle.close();
  }
}

/**
 * What a refused call tells the model. A 409 carries the current batch:
 * the model gets its projection, so it can show the new list and ask the
 * person to confirm again. Read from the error shape instead of importing
 * the SDK's helper, so the server still loads on an SDK without payables.
 */
export function payablesErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const e = err as { status?: unknown; body?: unknown };
  // The two auth answers in the API's own words, so the agent never reads a
  // missing scope as a broken key: 401 is the credential (wrong, revoked or for
  // another environment); 403 is one permission the key does not carry
  // (payables:pay to pay, for example) and the key stays good for the rest.
  if (e && e.status === 401) return `credential invalid or revoked (401): ${message}`;
  if (e && e.status === 403) {
    const body = e.body as { message?: unknown; error?: { message?: unknown } } | undefined;
    const said =
      typeof body?.message === "string" ? body.message : typeof body?.error?.message === "string" ? body.error.message : message;
    return `insufficient permission (403): ${said.replace(/\.$/, "")}. The key is valid; this one action needs a scope it does not carry.`;
  }
  const batch =
    e && e.status === 409
      ? (e.body as { error?: { details?: { batch?: unknown } } } | undefined)?.error?.details?.batch
      : undefined;
  if (!batch || typeof batch !== "object") return message;
  return JSON.stringify(
    {
      error: message,
      current_batch: projectBatch(batch as PayableBatch),
      next_step: "The list changed. Show it to the person; pay only after they confirm this version and list_hash.",
    },
    null,
    2,
  );
}

export interface PayablesToolOptions {
  /** True on the stdio server only: `upload` may read a local path. */
  allowLocalFiles: boolean;
}

/** Run one action through the facade. Throws on a refusal; the API's 409 carries the current batch on `err.body`. */
export async function callPayablesTool(
  payables: Payables,
  args: Record<string, unknown>,
  opts: PayablesToolOptions,
): Promise<unknown> {
  switch (args.action) {
    case "upload": {
      if (!opts.allowLocalFiles) throw new Error("upload needs the local MCP server; pass a file_id instead");
      const { bytes, filename } = await readLocalFile(str(args.path, "path"));
      return projectFile(await payables.files.upload(bytes, { filename }));
    }
    case "create_batch": {
      const fileIds = Array.isArray(args.file_ids) ? args.file_ids.filter(isString) : undefined;
      const stated = items(args.items);
      if (!fileIds?.length && !stated?.length) throw new Error("create_batch needs file_ids or items");
      const batch = await payables.batches.create(
        { ...(fileIds?.length ? { fileIds } : {}), ...(stated?.length ? { items: stated } : {}), source: "mcp" },
        isString(args.idempotency_key) ? { idempotencyKey: args.idempotency_key } : undefined,
      );
      return projectBatch(batch);
    }
    case "get":
      return projectBatch(await payables.batches.get(str(args.batch_id, "batch_id")));
    case "update_item": {
      const amountMinor = optional(args.amount_minor, isInt);
      const pixKey = optional(args.pix_key, isString);
      const boletoLine = optional(args.boleto_line, isString);
      const brCode = optional(args.br_code, isString);
      const excluded = typeof args.excluded === "boolean" ? args.excluded : undefined;
      const batch = await payables.batches.updateItem(str(args.batch_id, "batch_id"), str(args.item_id, "item_id"), {
        expectedVersion: int(args.expected_version, "expected_version"),
        ...(amountMinor !== undefined ? { amountMinor } : {}),
        ...(pixKey !== undefined ? { pixKey } : {}),
        ...(boletoLine !== undefined ? { boletoLine } : {}),
        ...(brCode !== undefined ? { brCode } : {}),
        ...(excluded !== undefined ? { excluded } : {}),
      });
      return projectBatch(batch);
    }
    case "pay": {
      const mandateId = optional(args.mandate_id, isString);
      const batch = await payables.batches.pay(str(args.batch_id, "batch_id"), {
        version: int(args.version, "version"),
        listHash: str(args.list_hash, "list_hash"),
        ...(mandateId ? { mandateId } : {}),
      });
      return projectBatch(batch);
    }
    default:
      throw new Error(`unknown codespar_payables action ${String(args.action)}`);
  }
}
