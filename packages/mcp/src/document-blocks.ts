/**
 * A document as MCP content blocks (29/10/2026), the contract the hosted
 * connector serves (enterprise `routes/mcp-presentation.ts`): a receipt's PNG
 * as an `image` block, a PDF as an embedded `resource` with the URI
 * `codespar://documents/receipts/<receipt_id>.pdf` or
 * `codespar://documents/statements/<from>_<to>.pdf`, nothing above 4 MiB, and
 * one sentence that says what is attached.
 *
 * The bytes are this caller's, fetched through the REST door the reference
 * names with the caller's own key: no public link, no token, no new route. A
 * client that ignores images or resources still has the JSON reference.
 */
import type { Document } from "@codespar/sdk";
import type { DocumentsFacades } from "./documents-tools.js";

/** Attachments above this size are not inlined (same bound as the hosted connector). */
export const MCP_INLINE_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

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
export function attachmentsSentence(attachments: readonly McpAttachment[]): string {
  const image = attachments.some((a) => a.type === "image");
  const pdf = attachments.some((a) => a.type === "resource");
  if (image && pdf) return "The receipt image (PNG) and the PDF are attached to this result.";
  if (pdf) return "The PDF is attached to this result.";
  if (image) return "The image (PNG) is attached to this result.";
  return "The document was produced but could not be attached now; fetch it through the path in the reference.";
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The document a `codespar_wallet` `receipt_document` / `statement_document`
 * call referenced, fetched and attached as the hosted connector does: the
 * receipt's PNG and PDF, the statement's PDF. Empty when the output names no
 * document or a download fails (the reference still stands).
 */
export async function walletDocumentBlocks(tool: string, payload: unknown, docs: DocumentsFacades): Promise<McpAttachment[]> {
  if (tool !== "codespar_wallet" || !isObj(payload) || !isObj(payload.document)) return [];
  const d = payload.document;
  const out: McpAttachment[] = [];
  try {
    if (d.kind === "receipt" && typeof d.receipt_id === "string") {
      const id: DocumentIdentity = { kind: "receipt", receipt_id: d.receipt_id };
      for (const format of ["png", "pdf"] as const) {
        const block = blockOf(await docs.receipts.document(d.receipt_id, { format }), id);
        if (block) out.push(block);
      }
    } else if (d.kind === "statement" && typeof d.from === "string" && typeof d.to === "string") {
      const currency = typeof d.currency === "string" ? d.currency : undefined;
      const block = blockOf(await docs.account.statement({ from: d.from, to: d.to, ...(currency ? { currency } : {}) }), {
        kind: "statement",
        from: d.from,
        to: d.to,
      });
      if (block) out.push(block);
    }
  } catch {
    return out;
  }
  return out;
}
