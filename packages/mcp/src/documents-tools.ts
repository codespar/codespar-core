/**
 * `codespar_documents` as an MCP tool (stdio server): the receipt document
 * (comprovante) of a payment and the account statement (extrato) of a
 * period, through the SDK facades `cs.receipts` and `cs.account`
 * (CONTRATO-documentos).
 *
 * The JSON answer is the reference, never bytes: with `out` (a local path,
 * this server runs on the person's machine) the file is written there and the
 * tool answers the path, the size and the content hash; without `out` it
 * answers the reference (filename, content type, size, hash) and the
 * authenticated API path. Since mcp 0.5.17 the downloaded document also rides
 * as an MCP content block, as the hosted connector serves it
 * (document-blocks.ts): a PNG as an image, a PDF as an embedded resource. Since
 * mcp 0.5.20 a statement also rides as its pages, PNG images before the PDF.
 * Generating a document never repeats a payment.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Account, Document, Receipts } from "@codespar/sdk";
import type { McpToolDefinition } from "./shop-purchase-tools.js";
import { blockOf, missingPagesSentence, statementPageBlocks, type McpAttachment } from "./document-blocks.js";

export const DOCUMENTS_TOOL_NAME = "codespar_documents";

export function documentsToolDefinition(): McpToolDefinition {
  return {
    name: DOCUMENTS_TOOL_NAME,
    description:
      "Documents on demand, generated from confirmed operations. action=receipt downloads the receipt document " +
      "(comprovante) of a payment by its receipt_id (rcpt_…), as pdf (default) or png (an image to share); served only " +
      "once the payment is confirmed (409 document_not_final before). action=statement downloads the account statement " +
      "(extrato) of a period (from, to as YYYY-MM-DD, at most 92 days, to not after today) as PDF: opening balance, " +
      "inflows, outflows, closing balance, reserves apart. With `out` the file is written to that local path and the " +
      "answer names it; without `out` the answer is the file's reference (name, type, size, sha256) and the API path. " +
      "The document itself is attached to the result: a PNG as an image, a PDF as an embedded resource; a statement " +
      "also as its pages, PNG images of 25 lines each (at most 8; the PDF carries every line). " +
      "Read-only: generating or downloading a document never repeats a payment.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["receipt", "statement"] },
        receipt_id: { type: "string", description: "action=receipt: the receipt (rcpt_…) of the payment." },
        format: { type: "string", enum: ["pdf", "png"], description: "action=receipt: pdf (default) or png." },
        from: { type: "string", description: "action=statement: first day, YYYY-MM-DD." },
        to: { type: "string", description: "action=statement: last day, inclusive, YYYY-MM-DD." },
        currency: { type: "string", description: "action=statement: ledger currency (default BRL)." },
        out: { type: "string", description: "A local path to write the file to. Without it, only the reference is answered." },
      },
    },
  };
}

export function isDocumentsTool(name: string): boolean {
  return name === DOCUMENTS_TOOL_NAME;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim().length === 0) throw new Error(`${name} is required`);
  return v.trim();
}

export interface DocumentsFacades {
  receipts: Receipts;
  account: Account;
}

/** What the model sees: never bytes. */
export function documentReference(doc: Document, extra: Record<string, unknown>, writtenTo: string | null): Record<string, unknown> {
  return {
    ...extra,
    filename: doc.filename,
    content_type: doc.contentType,
    bytes: doc.bytes.byteLength,
    sha256: doc.sha256,
    ...(writtenTo ? { path: writtenTo } : {}),
  };
}

/** Run one action. Throws on a refusal; the API's code is on `err.code`. */
export async function callDocumentsTool(cs: DocumentsFacades, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await runDocumentsTool(cs, args)).reference;
}

/**
 * Run one action and keep the document as MCP content blocks: the receipt's,
 * or the statement's pages as images and then its PDF. A block that does not
 * fit is left out; a statement page that does not come is named in `note`.
 */
export async function runDocumentsTool(
  cs: DocumentsFacades,
  args: Record<string, unknown>,
): Promise<{ reference: Record<string, unknown>; attachments: McpAttachment[]; note: string }> {
  const out = typeof args.out === "string" && args.out.trim().length > 0 ? resolve(args.out.trim()) : null;
  switch (args.action) {
    case "receipt": {
      const receiptId = str(args.receipt_id, "receipt_id");
      const format = args.format === undefined ? "pdf" : args.format;
      if (format !== "pdf" && format !== "png") throw new Error("format must be pdf or png");
      const doc = await cs.receipts.document(receiptId, { format });
      if (out) await writeFile(out, doc.bytes);
      return {
        reference: documentReference(
          doc,
          { action: "receipt", kind: "receipt", receipt_id: receiptId, format, api_path: `/v1/consumers/receipts/${encodeURIComponent(receiptId)}/document?format=${format}` },
          out,
        ),
        attachments: [blockOf(doc, { kind: "receipt", receipt_id: receiptId })].filter((b): b is McpAttachment => b !== null),
        note: "",
      };
    }
    case "statement": {
      const from = str(args.from, "from");
      const to = str(args.to, "to");
      const currency = typeof args.currency === "string" && args.currency.length > 0 ? args.currency : undefined;
      const period = { from, to, ...(currency ? { currency } : {}) };
      const doc = await cs.account.statement(period);
      if (out) await writeFile(out, doc.bytes);
      const pdf = blockOf(doc, { kind: "statement", from, to });
      const pages = await statementPageBlocks(cs.account, period);
      return {
        reference: documentReference(
          doc,
          {
            action: "statement",
            kind: "statement",
            from,
            to,
            format: "pdf",
            api_path: `/v1/account/statement?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&format=pdf`,
            page_images: { pages: pages.pages, attached: pages.images.length, missing: pages.missing },
          },
          out,
        ),
        attachments: [...pages.images, ...(pdf ? [pdf] : [])],
        note: missingPagesSentence(pages, pdf !== null),
      };
    }
    default:
      throw new Error(`unknown action ${String(args.action)} (use receipt | statement)`);
  }
}

/** The refusal as the model reads it: the API's code and message, nothing else. */
export function documentsErrorText(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof e?.code === "string" ? e.code : null;
  const message = err instanceof Error ? err.message : String(err);
  return code ? `${code}: ${message}` : message;
}
