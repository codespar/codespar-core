/**
 * Documents as MCP content blocks (mcp 0.5.17), the contract the hosted
 * connector serves: a receipt's PNG as an image, a PDF as an embedded resource
 * under codespar://documents/…, nothing above 4 MiB, one sentence that says
 * what is attached. Both doors: `codespar_documents` and a `codespar_wallet`
 * document action answered through the session.
 */
import { describe, expect, it } from "vitest";
import type { Document } from "@codespar/sdk";
import { MCP_INLINE_DOCUMENT_MAX_BYTES, attachmentsSentence, blockOf, walletDocumentBlocks } from "../document-blocks.js";
import { runDocumentsTool } from "../documents-tools.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const doc = (bytes: Uint8Array, contentType: string, filename = "f"): Document => ({ bytes, contentType, filename, sha256: "d".repeat(64) });

function facades(calls: unknown[][], opts: { failPdf?: boolean } = {}) {
  return {
    receipts: {
      async document(id: string, o?: { format?: "pdf" | "png" }) {
        calls.push(["receipts.document", id, o?.format]);
        if (o?.format === "pdf" && opts.failPdf) throw new Error("renderer down");
        return o?.format === "png" ? doc(PNG, "image/png") : doc(PDF, "application/pdf");
      },
    },
    account: {
      async statement(o: { from: string; to: string; currency?: string }) {
        calls.push(["account.statement", o]);
        return doc(PDF, "application/pdf");
      },
    },
  };
}

describe("a document as its block", () => {
  it("a PNG is an image; a PDF is a resource named by the receipt or the period", () => {
    expect(blockOf(doc(PNG, "image/png"), { kind: "receipt", receipt_id: "rcpt_1" })).toEqual({ type: "image", data: b64(PNG), mimeType: "image/png" });
    expect(blockOf(doc(PDF, "application/pdf"), { kind: "receipt", receipt_id: "rcpt_1" })).toEqual({
      type: "resource",
      resource: { uri: "codespar://documents/receipts/rcpt_1.pdf", mimeType: "application/pdf", blob: b64(PDF) },
    });
    expect(blockOf(doc(PDF, "application/pdf"), { kind: "statement", from: "2026-10-01", to: "2026-10-28" })).toMatchObject({
      resource: { uri: "codespar://documents/statements/2026-10-01_2026-10-28.pdf" },
    });
  });

  it("nothing above 4 MiB, nothing empty, nothing of another type", () => {
    const big = new Uint8Array(MCP_INLINE_DOCUMENT_MAX_BYTES + 1);
    expect(blockOf(doc(big, "application/pdf"), { kind: "receipt", receipt_id: "r" })).toBeNull();
    expect(blockOf(doc(new Uint8Array(0), "image/png"), { kind: "receipt", receipt_id: "r" })).toBeNull();
    expect(blockOf(doc(PDF, "text/html"), { kind: "receipt", receipt_id: "r" })).toBeNull();
  });

  it("the sentence says what is attached", () => {
    const img = { type: "image" as const, data: "", mimeType: "image/png" };
    const pdf = { type: "resource" as const, resource: { uri: "u", mimeType: "application/pdf", blob: "" } };
    expect(attachmentsSentence([img, pdf])).toBe("The receipt image (PNG) and the PDF are attached to this result.");
    expect(attachmentsSentence([pdf])).toBe("The PDF is attached to this result.");
    expect(attachmentsSentence([])).toMatch(/could not be attached now/);
  });
});

describe("codespar_documents carries its document", () => {
  it("a receipt as png comes back as the reference and the image", async () => {
    const calls: unknown[][] = [];
    const out = await runDocumentsTool(facades(calls), { action: "receipt", receipt_id: "rcpt_1", format: "png" });
    expect(out.reference).toMatchObject({ kind: "receipt", receipt_id: "rcpt_1", format: "png" });
    expect(out.attachment).toEqual({ type: "image", data: b64(PNG), mimeType: "image/png" });
    expect(JSON.stringify(out.reference)).not.toContain(b64(PNG));
  });

  it("a statement comes back as the reference and the PDF resource", async () => {
    const out = await runDocumentsTool(facades([]), { action: "statement", from: "2026-10-01", to: "2026-10-28" });
    expect(out.attachment).toMatchObject({ type: "resource", resource: { uri: "codespar://documents/statements/2026-10-01_2026-10-28.pdf" } });
  });
});

describe("a codespar_wallet document action through the session", () => {
  it("a receipt reference fetches and attaches its PNG and its PDF, in that order", async () => {
    const calls: unknown[][] = [];
    const blocks = await walletDocumentBlocks("codespar_wallet", { action: "receipt_document", document: { kind: "receipt", receipt_id: "rcpt_9" } }, facades(calls));
    expect(blocks.map((b) => b.type)).toEqual(["image", "resource"]);
    expect(calls).toEqual([
      ["receipts.document", "rcpt_9", "png"],
      ["receipts.document", "rcpt_9", "pdf"],
    ]);
  });

  it("a statement reference attaches its PDF with the currency it named", async () => {
    const calls: unknown[][] = [];
    const blocks = await walletDocumentBlocks(
      "codespar_wallet",
      { action: "statement_document", document: { kind: "statement", from: "2026-10-01", to: "2026-10-28", currency: "BRL" } },
      facades(calls),
    );
    expect(blocks).toHaveLength(1);
    expect(calls).toEqual([["account.statement", { from: "2026-10-01", to: "2026-10-28", currency: "BRL" }]]);
  });

  it("another tool, another output or a failed download attaches what it has, never throws", async () => {
    expect(await walletDocumentBlocks("codespar_pay", { document: { kind: "receipt", receipt_id: "r" } }, facades([]))).toEqual([]);
    expect(await walletDocumentBlocks("codespar_wallet", { action: "balance" }, facades([]))).toEqual([]);
    const partial = await walletDocumentBlocks("codespar_wallet", { document: { kind: "receipt", receipt_id: "r" } }, facades([], { failPdf: true }));
    expect(partial.map((b) => b.type)).toEqual(["image"]);
  });
});
