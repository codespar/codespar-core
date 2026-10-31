/**
 * A document as MCP content blocks (29/10/2026), the contract the hosted
 * connector serves (enterprise `routes/mcp-presentation.ts`): a receipt's PNG
 * as an `image` block, a statement's pages as PNG `image` blocks (30/10/2026),
 * a PDF as an embedded `resource` with the URI
 * `codespar://documents/receipts/<receipt_id>.pdf` or
 * `codespar://documents/statements/<from>_<to>.pdf`, nothing above 4 MiB, and
 * one sentence that says what is attached.
 *
 * The bytes are this caller's, fetched through the REST door the reference
 * names with the caller's own key: no public link, no token, no new route. A
 * client that ignores images or resources still has the JSON reference.
 */
import type { Account, Document } from "@codespar/sdk";
import type { DocumentsFacades } from "./documents-tools.js";

/** Attachments above this size are not inlined (same bound as the hosted connector). */
export const MCP_INLINE_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

/** At most this many statement pages ride as images (enterprise `STATEMENT_IMAGE_MAX_PAGES`); the PDF carries every line. */
export const STATEMENT_IMAGE_MAX_PAGES = 8;

export type McpAttachment =
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** What a document is, for its block's URI. */
export type DocumentIdentity = { kind: "receipt"; receipt_id: string } | { kind: "statement"; from: string; to: string };

const fits = (d: Document): boolean => d.bytes.byteLength > 0 && d.bytes.byteLength <= MCP_INLINE_DOCUMENT_MAX_BYTES;

function base64(d: Document): string {
  return Buffer.from(d.bytes).toString("base64");
}

/** One downloaded document as its block: a PNG as an image, a PDF as a resource. Null when it does not fit. */
export function blockOf(doc: Document, id: DocumentIdentity): McpAttachment | null {
  if (!fits(doc)) return null;
  if (doc.contentType.startsWith("image/png")) return { type: "image", data: base64(doc), mimeType: "image/png" };
  if (doc.contentType.startsWith("application/pdf")) {
    const uri =
      id.kind === "receipt"
        ? `codespar://documents/receipts/${id.receipt_id}.pdf`
        : `codespar://documents/statements/${id.from}_${id.to}.pdf`;
    return { type: "resource", resource: { uri, mimeType: "application/pdf", blob: base64(doc) } };
  }
  return null;
}

/** The sentence after the reference: what is attached, or that nothing could be inlined. */
export function attachmentsSentence(attachments: readonly McpAttachment[], kind: DocumentIdentity["kind"] = "receipt"): string {
  const images = attachments.filter((a) => a.type === "image").length;
  const image = images > 0;
  const pdf = attachments.some((a) => a.type === "resource");
  if (images > 1 && pdf) return `The statement pages (${images} PNG images) and the PDF are attached to this result.`;
  if (image && pdf) return kind === "statement" ? "The statement page (PNG) and the PDF are attached to this result." : "The receipt image (PNG) and the PDF are attached to this result.";
  if (pdf) return "The PDF is attached to this result.";
  if (image) return "The image (PNG) is attached to this result.";
  return "The document was produced but could not be attached now; fetch it through the path in the reference.";
}

/** A statement page that did not become an image, and why (the API's code when it sent one). */
export interface MissingStatementPage {
  page: number;
  reason: string;
}

/** The statement's pages as image blocks, in page order, and the pages that are not among them. */
export interface StatementPageBlocks {
  images: McpAttachment[];
  /** How many pages the API said the statement has as images; null when page 1 could not be read. */
  pages: number | null;
  missing: MissingStatementPage[];
}

function reasonOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : "download_failed";
}

/**
 * The statement's pages as PNG images, the hosted connector's `statementPages`
 * through the REST door (`format=png&page=N`): page 1 first, whose answer says
 * how many pages there are, then the others up to STATEMENT_IMAGE_MAX_PAGES.
 * One at a time, because the API renders the statement on every call. A page
 * that fails or does not fit is named in `missing` and the rest still come;
 * nothing is left out silently. An SDK older than 0.16.28 reads no page count,
 * so only page 1 comes then.
 */
export async function statementPageBlocks(account: Account, period: { from: string; to: string; currency?: string }): Promise<StatementPageBlocks> {
  const id: DocumentIdentity = { kind: "statement", from: period.from, to: period.to };
  const images: McpAttachment[] = [];
  const missing: MissingStatementPage[] = [];
  const fetchPage = async (page: number): Promise<number | null> => {
    try {
      const doc = await account.statement({ ...period, format: "png", page });
      const block = doc.contentType.startsWith("image/png") ? blockOf(doc, id) : null;
      if (block) images.push(block);
      else missing.push({ page, reason: "not_attachable" });
      return typeof doc.pages === "number" ? doc.pages : 1;
    } catch (err) {
      missing.push({ page, reason: reasonOf(err) });
      return null;
    }
  };
  const pages = await fetchPage(1);
  if (pages === null) return { images, pages, missing };
  for (let page = 2; page <= Math.min(pages, STATEMENT_IMAGE_MAX_PAGES); page += 1) await fetchPage(page);
  return { images, pages, missing };
}

/** The sentence that names the pages that are not attached; empty when none is missing. */
export function missingPagesSentence(pages: StatementPageBlocks, pdfAttached: boolean): string {
  if (pages.missing.length === 0) return "";
  const which = pages.missing.map((m) => `page ${m.page} (${m.reason})`).join(", ");
  const of = pages.pages === null ? "" : ` of ${Math.min(pages.pages, STATEMENT_IMAGE_MAX_PAGES)}`;
  const rest = pdfAttached ? " The PDF carries every line." : "";
  return `Statement pages not attached as images${of}: ${which}.${rest}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** What a `codespar_wallet` document action attaches: the blocks, the document's kind and the text that goes with them. */
export interface WalletDocumentBlocks {
  attachments: McpAttachment[];
  kind: DocumentIdentity["kind"] | null;
  /** The pages that did not come, for a statement; empty otherwise. */
  note: string;
}

/**
 * The document a `codespar_wallet` `receipt_document` / `statement_document`
 * call referenced, fetched and attached as the hosted connector does: the
 * receipt's PNG and PDF; the statement's pages as PNG images and its PDF.
 * Empty when the output names no document or a download fails (the reference
 * still stands); a statement page that fails is named in `note`.
 */
export async function walletDocumentBlocks(tool: string, payload: unknown, docs: DocumentsFacades): Promise<WalletDocumentBlocks> {
  if (tool !== "codespar_wallet" || !isObj(payload) || !isObj(payload.document)) return { attachments: [], kind: null, note: "" };
  const d = payload.document;
  const out: McpAttachment[] = [];
  if (d.kind === "receipt" && typeof d.receipt_id === "string") {
    const id: DocumentIdentity = { kind: "receipt", receipt_id: d.receipt_id };
    try {
      for (const format of ["png", "pdf"] as const) {
        const block = blockOf(await docs.receipts.document(d.receipt_id, { format }), id);
        if (block) out.push(block);
      }
    } catch {
      // The reference still stands; what was fetched is attached.
    }
    return { attachments: out, kind: "receipt", note: "" };
  }
  if (d.kind === "statement" && typeof d.from === "string" && typeof d.to === "string") {
    const currency = typeof d.currency === "string" ? d.currency : undefined;
    const period = { from: d.from, to: d.to, ...(currency ? { currency } : {}) };
    const pages = await statementPageBlocks(docs.account, period);
    let pdf: McpAttachment | null = null;
    try {
      pdf = blockOf(await docs.account.statement(period), { kind: "statement", from: d.from, to: d.to });
    } catch {
      // The pages and the reference still stand.
    }
    const attachments = [...pages.images, ...(pdf ? [pdf] : [])];
    return { attachments, kind: "statement", note: missingPagesSentence(pages, pdf !== null) };
  }
  return { attachments: [], kind: null, note: "" };
}
