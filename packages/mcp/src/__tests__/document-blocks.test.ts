/**
 * Documents as MCP content blocks (mcp 0.5.17), the contract the hosted
 * connector serves: a receipt's PNG as an image, a statement's pages as PNG
 * images (mcp 0.5.20), a PDF as an embedded resource under
 * codespar://documents/…, nothing above 4 MiB, one sentence that says what is
 * attached and which statement pages did not come. Both doors:
 * `codespar_documents` and a `codespar_wallet` document action answered
 * through the session.
 */
import { describe, expect, it } from "vitest";
import type { Document, StatementDocument } from "@codespar/sdk";
import {
  MCP_INLINE_DOCUMENT_MAX_BYTES,
  STATEMENT_IMAGE_MAX_PAGES,
  attachmentsSentence,
  blockOf,
  missingPagesSentence,
  statementPageBlocks,
  walletDocumentBlocks,
} from "../document-blocks.js";
import { runDocumentsTool } from "../documents-tools.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const doc = (bytes: Uint8Array, contentType: string, filename = "f"): Document => ({ bytes, contentType, filename, sha256: "d".repeat(64) });

/** Page N of a statement as the API serves it: its own bytes, so the order of the blocks can be read back. */
const pagePng = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

interface StatementScript {
  /** The `X-CodeSpar-Document-Pages` the API answers; undefined = an SDK that reads no header. */
  pages?: number;
  /** Pages that answer this error instead of their image. */
  fail?: Record<number, Error & { code?: string }>;
}

function apiError(code: string, status: number, details?: Record<string, unknown>): Error & { code: string } {
  return Object.assign(new Error(code), { code, status, details });
}

function facades(calls: unknown[][], opts: { failPdf?: boolean; statement?: StatementScript } = {}) {
  const script = opts.statement ?? { pages: 1 };
  return {
    receipts: {
      async document(id: string, o?: { format?: "pdf" | "png" }) {
        calls.push(["receipts.document", id, o?.format]);
        if (o?.format === "pdf" && opts.failPdf) throw new Error("renderer down");
        return o?.format === "png" ? doc(PNG, "image/png") : doc(PDF, "application/pdf");
      },
    },
    account: {
      async statement(o: { from: string; to: string; currency?: string; format?: "pdf" | "png"; page?: number }): Promise<StatementDocument> {
        calls.push(["account.statement", o]);
        if (o.format !== "png") return { ...doc(PDF, "application/pdf"), pages: null };
        const page = o.page ?? 1;
        const failure = script.fail?.[page];
        if (failure) throw failure;
        const total = script.pages ?? 1;
        if (page > total) throw apiError("statement_page_not_found", 404, { page, pages: total });
        return { ...doc(pagePng(page), "image/png"), pages: script.pages as number };
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
    expect(attachmentsSentence([img, pdf], "statement")).toBe("The statement page (PNG) and the PDF are attached to this result.");
    expect(attachmentsSentence([img, img, img, pdf], "statement")).toBe("The statement pages (3 PNG images) and the PDF are attached to this result.");
    expect(attachmentsSentence([pdf])).toBe("The PDF is attached to this result.");
    expect(attachmentsSentence([])).toMatch(/could not be attached now/);
  });
});

describe("codespar_documents carries its document", () => {
  it("a receipt as png comes back as the reference and the image", async () => {
    const calls: unknown[][] = [];
    const out = await runDocumentsTool(facades(calls), { action: "receipt", receipt_id: "rcpt_1", format: "png" });
    expect(out.reference).toMatchObject({ kind: "receipt", receipt_id: "rcpt_1", format: "png" });
    expect(out.attachments).toEqual([{ type: "image", data: b64(PNG), mimeType: "image/png" }]);
    expect(out.note).toBe("");
    expect(JSON.stringify(out.reference)).not.toContain(b64(PNG));
  });

  it("a statement of 3 pages comes back as the reference, the 3 page images in order, then the PDF", async () => {
    const calls: unknown[][] = [];
    const out = await runDocumentsTool(facades(calls, { statement: { pages: 3 } }), { action: "statement", from: "2026-10-01", to: "2026-10-28" });
    expect(out.attachments.map((a) => (a.type === "image" ? a.data : a.resource.uri))).toEqual([
      b64(pagePng(1)),
      b64(pagePng(2)),
      b64(pagePng(3)),
      "codespar://documents/statements/2026-10-01_2026-10-28.pdf",
    ]);
    expect(out.reference).toMatchObject({ format: "pdf", content_type: "application/pdf", page_images: { pages: 3, attached: 3, missing: [] } });
    expect(out.note).toBe("");
    expect(calls).toEqual([
      ["account.statement", { from: "2026-10-01", to: "2026-10-28" }],
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", format: "png", page: 1 }],
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", format: "png", page: 2 }],
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", format: "png", page: 3 }],
    ]);
  });

  it("a statement whose page 2 fails still attaches pages 1 and 3 and the PDF, and the note names page 2", async () => {
    const out = await runDocumentsTool(facades([], { statement: { pages: 3, fail: { 2: apiError("network_error", 0) } } }), {
      action: "statement",
      from: "2026-10-01",
      to: "2026-10-28",
    });
    expect(out.attachments.map((a) => (a.type === "image" ? a.data : "pdf"))).toEqual([b64(pagePng(1)), b64(pagePng(3)), "pdf"]);
    expect(out.reference).toMatchObject({ page_images: { pages: 3, attached: 2, missing: [{ page: 2, reason: "network_error" }] } });
    expect(out.note).toBe("Statement pages not attached as images of 3: page 2 (network_error). The PDF carries every line.");
  });

  it("a statement the API refuses is an error, with no page fetched", async () => {
    const calls: unknown[][] = [];
    const cs = facades(calls);
    cs.account.statement = async (o) => {
      calls.push(["account.statement", o]);
      throw apiError("statement_not_reconciled", 500);
    };
    await expect(runDocumentsTool(cs, { action: "statement", from: "2026-10-01", to: "2026-10-28" })).rejects.toMatchObject({ code: "statement_not_reconciled" });
    expect(calls).toHaveLength(1);
  });
});

describe("a statement's pages as images", () => {
  const period = { from: "2026-10-01", to: "2026-10-28" };

  it("page 1 says how many there are; the others follow, one call each, never past the eighth", async () => {
    const calls: unknown[][] = [];
    const out = await statementPageBlocks(facades(calls, { statement: { pages: 11 } }).account, period);
    expect(out.images).toHaveLength(STATEMENT_IMAGE_MAX_PAGES);
    expect(out.pages).toBe(11);
    expect(calls.map((c) => (c[1] as { page: number }).page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("a page past the end (404 statement_page_not_found) is named, not dropped", async () => {
    // The statement shrank between page 1 and page 3: the count said 3, page 3 answers 404.
    const out = await statementPageBlocks(
      facades([], { statement: { pages: 3, fail: { 3: apiError("statement_page_not_found", 404, { page: 3, pages: 2 }) } } }).account,
      period,
    );
    expect(out.images).toHaveLength(2);
    expect(out.missing).toEqual([{ page: 3, reason: "statement_page_not_found" }]);
    expect(missingPagesSentence(out, false)).toBe("Statement pages not attached as images of 3: page 3 (statement_page_not_found).");
  });

  it("page 1 failing leaves the count unknown and says so", async () => {
    const out = await statementPageBlocks(facades([], { statement: { pages: 3, fail: { 1: apiError("statement_page_invalid", 400) } } }).account, period);
    expect(out).toEqual({ images: [], pages: null, missing: [{ page: 1, reason: "statement_page_invalid" }] });
    expect(missingPagesSentence(out, true)).toBe("Statement pages not attached as images: page 1 (statement_page_invalid). The PDF carries every line.");
  });

  it("an SDK that reads no page count brings page 1 only", async () => {
    const calls: unknown[][] = [];
    const out = await statementPageBlocks(facades(calls, { statement: {} }).account, period);
    expect(out.images).toHaveLength(1);
    expect(out.missing).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
});

describe("a codespar_wallet document action through the session", () => {
  it("a receipt reference fetches and attaches its PNG and its PDF, in that order", async () => {
    const calls: unknown[][] = [];
    const blocks = await walletDocumentBlocks("codespar_wallet", { action: "receipt_document", document: { kind: "receipt", receipt_id: "rcpt_9" } }, facades(calls));
    expect(blocks.kind).toBe("receipt");
    expect(blocks.attachments.map((b) => b.type)).toEqual(["image", "resource"]);
    expect(calls).toEqual([
      ["receipts.document", "rcpt_9", "png"],
      ["receipts.document", "rcpt_9", "pdf"],
    ]);
  });

  it("a statement reference attaches its pages and then its PDF, with the currency it named; the PDF call is the one it always was", async () => {
    const calls: unknown[][] = [];
    const blocks = await walletDocumentBlocks(
      "codespar_wallet",
      { action: "statement_document", document: { kind: "statement", from: "2026-10-01", to: "2026-10-28", currency: "BRL" } },
      facades(calls, { statement: { pages: 2 } }),
    );
    expect(blocks.kind).toBe("statement");
    expect(blocks.attachments.map((b) => b.type)).toEqual(["image", "image", "resource"]);
    expect(blocks.attachments[2]).toEqual({
      type: "resource",
      resource: { uri: "codespar://documents/statements/2026-10-01_2026-10-28.pdf", mimeType: "application/pdf", blob: b64(PDF) },
    });
    expect(blocks.note).toBe("");
    expect(calls).toEqual([
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", currency: "BRL", format: "png", page: 1 }],
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", currency: "BRL", format: "png", page: 2 }],
      ["account.statement", { from: "2026-10-01", to: "2026-10-28", currency: "BRL" }],
    ]);
  });

  it("a statement page that fails is named in the note; the other pages and the PDF still come", async () => {
    const blocks = await walletDocumentBlocks(
      "codespar_wallet",
      { action: "statement_document", document: { kind: "statement", from: "2026-10-01", to: "2026-10-28" } },
      facades([], { statement: { pages: 3, fail: { 1: apiError("network_error", 0) } } }),
    );
    // Page 1 carries the count: without it the others are not guessed at, and the note says so.
    expect(blocks.attachments.map((b) => b.type)).toEqual(["resource"]);
    expect(blocks.note).toBe("Statement pages not attached as images: page 1 (network_error). The PDF carries every line.");
  });

  it("another tool, another output or a failed download attaches what it has, never throws", async () => {
    const none = { attachments: [], kind: null, note: "" };
    expect(await walletDocumentBlocks("codespar_pay", { document: { kind: "receipt", receipt_id: "r" } }, facades([]))).toEqual(none);
    expect(await walletDocumentBlocks("codespar_wallet", { action: "balance" }, facades([]))).toEqual(none);
    const partial = await walletDocumentBlocks("codespar_wallet", { document: { kind: "receipt", receipt_id: "r" } }, facades([], { failPdf: true }));
    expect(partial.attachments.map((b) => b.type)).toEqual(["image"]);
  });
});
