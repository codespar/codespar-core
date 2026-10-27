/**
 * `codespar receipts document` and `codespar account statement`: documents
 * on demand (CONTRATO-documentos), through the SDK facades `cs.receipts` and
 * `cs.account`. Hand-written because the answer is a FILE, not JSON: the
 * bytes go to `--out` (or to the server's filename in the current directory)
 * and the terminal gets the name, the size and the content hash.
 *
 * Read-only: generating or downloading a document never repeats a payment.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodeSpar, type Document } from "@codespar/sdk";
import { CliError } from "../config.js";
import { json, kv, success } from "../output.js";

export interface DocumentsAuth {
  apiKey: string;
  baseUrl: string;
  project?: string;
  json?: boolean;
}

function client(auth: DocumentsAuth): CodeSpar {
  return new CodeSpar({ apiKey: auth.apiKey, baseUrl: auth.baseUrl, projectId: auth.project });
}

/** Writes the document and prints where it went. `out` wins over the server's filename. */
export async function saveDocument(doc: Document, out: string | undefined, auth: DocumentsAuth, extra: Record<string, unknown>): Promise<string> {
  const target = resolve(out ?? doc.filename);
  await writeFile(target, doc.bytes);
  const record = { ...extra, path: target, filename: doc.filename, content_type: doc.contentType, bytes: doc.bytes.byteLength, sha256: doc.sha256 };
  if (auth.json) {
    json(record);
  } else {
    success(`Saved ${target}`);
    kv([
      ["Content type", doc.contentType],
      ["Bytes", String(doc.bytes.byteLength)],
      ...(doc.sha256 ? ([["Content sha256", doc.sha256]] as Array<[string, string]>) : []),
    ]);
  }
  return target;
}

export interface ReceiptDocumentOptions extends DocumentsAuth {
  format?: string;
  out?: string;
}

export async function receiptsDocumentCommand(receiptId: string, opts: ReceiptDocumentOptions): Promise<void> {
  if (!receiptId) throw new CliError("a receipt id is required: codespar receipts document <receiptId>");
  const format = opts.format ?? "pdf";
  if (format !== "pdf" && format !== "png") throw new CliError(`--format must be pdf or png (got ${format})`);
  const doc = await client(opts).receipts.document(receiptId, { format });
  await saveDocument(doc, opts.out, opts, { kind: "receipt", receipt_id: receiptId, format });
}

export interface StatementOptions extends DocumentsAuth {
  from?: string;
  to?: string;
  currency?: string;
  out?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function accountStatementCommand(opts: StatementOptions): Promise<void> {
  if (!opts.from || !opts.to) throw new CliError("--from and --to are required (YYYY-MM-DD)");
  if (!DAY.test(opts.from) || !DAY.test(opts.to)) throw new CliError("--from and --to must be calendar days, YYYY-MM-DD");
  if (opts.from > opts.to) throw new CliError("--from must not be after --to");
  const doc = await client(opts).account.statement({ from: opts.from, to: opts.to, ...(opts.currency ? { currency: opts.currency } : {}) });
  await saveDocument(doc, opts.out, opts, { kind: "statement", from: opts.from, to: opts.to, format: "pdf" });
}
