/**
 * Documents on demand (CONTRATO-documentos, 26/10/2026): the payment receipt
 * (comprovante) of a sealed receipt, as PDF or PNG, and the account
 * statement (extrato) of a period, as PDF or as PNG pages.
 *
 *   cs.receipts.document(receiptId, { format })          GET /v1/consumers/receipts/:id/document
 *   cs.account.statement({ from, to })                     GET /v1/account/statement
 *   cs.account.statement({ from, to, format: "png", page }) GET /v1/account/statement?format=png&page=N
 *
 * Both are reads: generating or downloading a document never repeats a
 * payment. The API serves a receipt document only for a confirmed payment
 * (409 `document_not_final` otherwise) and a statement only when it
 * reconciles (500 `statement_not_reconciled` otherwise); both refusals reach
 * you as `CodesparApiError` with that `code`. `sha256` is the API's hash of
 * the document's content (`X-CodeSpar-Document-Sha256`): the same receipt
 * answers the same value on every call.
 */
import { CodesparApiError, networkErrorToApiError, throwFromResponse, TimeoutError } from "./errors.js";
import { fetchWithTimeout } from "./internal/fetch.js";
import type { CallOptions } from "./types.js";

export type DocumentFormat = "pdf" | "png";

/** A downloaded document: the bytes, their type, the server's file name and the content hash. */
export interface Document {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  /** `X-CodeSpar-Document-Sha256`; null when the server sent none. */
  sha256: string | null;
}

export interface ReceiptDocumentOptions extends CallOptions {
  /** `pdf` (default, one page of 600x828 px) or `png` (the same page at 2x, 1200x1656). */
  format?: DocumentFormat;
}

export interface StatementOptions extends CallOptions {
  /** First day of the period, `YYYY-MM-DD` (America/Sao_Paulo). */
  from: string;
  /** Last day, inclusive; not after today; at most 92 days after `from`. */
  to: string;
  /**
   * `pdf` (default): the whole period. `png`: ONE page of the statement as an
   * image, chosen by `page` (25 lines a page, at most 8 pages; the PDF carries
   * every line). `pages` on the answer says how many there are.
   */
  format?: DocumentFormat;
  /** With `format: "png"`: the page, 1-based (default 1). Past the last page: 404 `statement_page_not_found` with `{ page, pages }`. */
  page?: number;
  /** The ledger currency (default BRL). */
  currency?: string;
}

/** A statement: for a PNG page, `pages` is how many PNG pages the statement has (`X-CodeSpar-Document-Pages`). */
export interface StatementDocument extends Document {
  /** Null for the PDF (the server sends no pages header for it). */
  pages: number | null;
}

export interface Receipts {
  /** `GET /v1/consumers/receipts/:id/document`: the comprovante of the payment the receipt seals. */
  document(receiptId: string, opts?: ReceiptDocumentOptions): Promise<Document>;
}

export interface Account {
  /** `GET /v1/account/statement`: the extrato of the project's account over `[from, to]`, as PDF or one PNG page. */
  statement(opts: StatementOptions): Promise<StatementDocument>;
}

interface DocumentsDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}

/** `comprovante-rcpt_x.pdf` out of `attachment; filename="comprovante-rcpt_x.pdf"`, else null. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  const name = m?.[1]?.trim();
  return name && !/[\\/]/.test(name) ? name : null;
}

function pagesHeader(header: string | null): number | null {
  const n = header === null ? NaN : Number(header);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function createDocuments(deps: DocumentsDeps): { receipts: Receipts; account: Account } {
  const auth: Record<string, string> = { Authorization: `Bearer ${deps.apiKey}` };
  if (deps.projectId) auth["x-codespar-project"] = deps.projectId;

  async function download(what: string, url: string, fallbackName: string, accept: string, opts: CallOptions | undefined): Promise<StatementDocument> {
    try {
      return await fetchWithTimeout(
        url,
        { method: "GET", headers: { ...auth, Accept: `${accept}, application/json` } },
        { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal },
        async (r) => {
          if (!r.ok) await throwFromResponse(r, what);
          const bytes = new Uint8Array(await r.arrayBuffer());
          return {
            bytes,
            contentType: r.headers.get("content-type")?.split(";")[0]?.trim() ?? accept,
            filename: filenameFromDisposition(r.headers.get("content-disposition")) ?? fallbackName,
            sha256: r.headers.get("x-codespar-document-sha256"),
            pages: pagesHeader(r.headers.get("x-codespar-document-pages")),
          };
        },
      );
    } catch (cause) {
      if (cause instanceof TimeoutError) throw cause;
      if (cause instanceof CodesparApiError) throw cause;
      if (opts?.signal?.aborted) throw cause;
      throw networkErrorToApiError(cause, what);
    }
  }

  return {
    receipts: {
      document(receiptId, opts) {
        if (!receiptId) throw new CodesparApiError("receipts.document: receiptId is required", { status: 0, code: "invalid_args" });
        const format: DocumentFormat = opts?.format ?? "pdf";
        if (format !== "pdf" && format !== "png") throw new CodesparApiError("receipts.document: format must be pdf or png", { status: 0, code: "invalid_args" });
        const url = `${deps.baseUrl}/v1/consumers/receipts/${encodeURIComponent(receiptId)}/document?format=${format}`;
        return download("receipts.document", url, `comprovante-${receiptId}.${format}`, format === "pdf" ? "application/pdf" : "image/png", opts).then(
          ({ pages: _pages, ...doc }) => doc,
        );
      },
    },
    account: {
      statement(opts) {
        if (!opts?.from || !opts.to) throw new CodesparApiError("account.statement: from and to are required (YYYY-MM-DD)", { status: 0, code: "invalid_args" });
        const format: DocumentFormat = opts.format ?? "pdf";
        if (format !== "pdf" && format !== "png") throw new CodesparApiError("account.statement: format must be pdf or png", { status: 0, code: "invalid_args" });
        if (opts.page !== undefined && (format !== "png" || !Number.isInteger(opts.page) || opts.page < 1)) {
          throw new CodesparApiError("account.statement: page is a whole number, 1 or more, with format png", { status: 0, code: "invalid_args" });
        }
        const q = new URLSearchParams({ from: opts.from, to: opts.to, format });
        if (format === "png") q.set("page", String(opts.page ?? 1));
        if (opts.currency) q.set("currency", opts.currency);
        const url = `${deps.baseUrl}/v1/account/statement?${q.toString()}`;
        if (format === "pdf") return download("account.statement", url, `extrato-${opts.from}-${opts.to}.pdf`, "application/pdf", opts);
        return download("account.statement", url, `extrato-${opts.from}-${opts.to}-p${opts.page ?? 1}.png`, "image/png", opts);
      },
    },
  };
}
