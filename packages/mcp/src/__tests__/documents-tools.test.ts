/**
 * `codespar_documents` over MCP: a closed schema, each action through the
 * SDK facades, the file written only with `out`, and what returns to the
 * model is a reference (name, type, size, hash, API path), never bytes.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Document, StatementDocument } from "@codespar/sdk";
import { callDocumentsTool, documentsErrorText, documentsToolDefinition, isDocumentsTool } from "../documents-tools.js";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const doc = (filename: string, contentType: string): Document => ({ bytes: PDF, contentType, filename, sha256: "d".repeat(64) });

function facades(calls: unknown[][]) {
  return {
    receipts: {
      async document(id: string, opts?: { format?: "pdf" | "png" }) {
        calls.push(["receipts.document", id, opts]);
        if (id === "rcpt_u") throw Object.assign(new Error("not yet"), { status: 409, code: "document_not_final" });
        return doc(`comprovante-${id}.${opts?.format ?? "pdf"}`, opts?.format === "png" ? "image/png" : "application/pdf");
      },
    },
    account: {
      async statement(opts: { from: string; to: string; currency?: string; format?: "pdf" | "png"; page?: number }): Promise<StatementDocument> {
        calls.push(["account.statement", opts]);
        if (opts.format === "png") return { ...doc(`extrato-${opts.from}-${opts.to}-p${opts.page}.png`, "image/png"), pages: 1 };
        return { ...doc(`extrato-${opts.from}-${opts.to}.pdf`, "application/pdf"), pages: null };
      },
    },
  };
}

describe("codespar_documents", () => {
  it("is named and closed: two actions, no extra properties", () => {
    expect(isDocumentsTool("codespar_documents")).toBe(true);
    expect(isDocumentsTool("codespar_wallet")).toBe(false);
    const def = documentsToolDefinition();
    expect(def.name).toBe("codespar_documents");
    expect(def.inputSchema.additionalProperties).toBe(false);
    expect((def.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum).toEqual(["receipt", "statement"]);
    expect(def.description).toContain("never repeats a payment");
  });

  it("receipt without out: the reference, never bytes", async () => {
    const calls: unknown[][] = [];
    const out = await callDocumentsTool(facades(calls), { action: "receipt", receipt_id: "rcpt_x", format: "png" });
    expect(calls).toEqual([["receipts.document", "rcpt_x", { format: "png" }]]);
    expect(out).toEqual({
      action: "receipt",
      kind: "receipt",
      receipt_id: "rcpt_x",
      format: "png",
      api_path: "/v1/consumers/receipts/rcpt_x/document?format=png",
      filename: "comprovante-rcpt_x.png",
      content_type: "image/png",
      bytes: PDF.byteLength,
      sha256: "d".repeat(64),
    });
    expect(JSON.stringify(out)).not.toContain("PDF-");
  });

  it("receipt with out: the file is written and the answer names the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codespar-mcp-docs-"));
    const target = join(dir, "c.pdf");
    const out = await callDocumentsTool(facades([]), { action: "receipt", receipt_id: "rcpt_x", out: target });
    expect(out).toMatchObject({ format: "pdf", path: target, filename: "comprovante-rcpt_x.pdf" });
    expect(readFileSync(target).equals(Buffer.from(PDF))).toBe(true);
  });

  it("statement: from/to through the facade, currency when given; the PDF first, then its page images", async () => {
    const calls: unknown[][] = [];
    const out = await callDocumentsTool(facades(calls), { action: "statement", from: "2026-09-01", to: "2026-09-30", currency: "BRL" });
    expect(calls).toEqual([
      ["account.statement", { from: "2026-09-01", to: "2026-09-30", currency: "BRL" }],
      ["account.statement", { from: "2026-09-01", to: "2026-09-30", currency: "BRL", format: "png", page: 1 }],
    ]);
    expect(out).toMatchObject({ action: "statement", kind: "statement", from: "2026-09-01", to: "2026-09-30", format: "pdf", filename: "extrato-2026-09-01-2026-09-30.pdf", api_path: "/v1/account/statement?from=2026-09-01&to=2026-09-30&format=pdf" });
  });

  it("refuses what it does not know before any call, and relays the API's code", async () => {
    const calls: unknown[][] = [];
    await expect(callDocumentsTool(facades(calls), { action: "receipt" })).rejects.toThrow(/receipt_id is required/);
    await expect(callDocumentsTool(facades(calls), { action: "receipt", receipt_id: "rcpt_x", format: "docx" })).rejects.toThrow(/pdf or png/);
    await expect(callDocumentsTool(facades(calls), { action: "statement", from: "2026-09-01" })).rejects.toThrow(/to is required/);
    await expect(callDocumentsTool(facades(calls), { action: "pay" })).rejects.toThrow(/unknown action/);
    expect(calls).toHaveLength(0);
    const dir = mkdtempSync(join(tmpdir(), "codespar-mcp-docs-"));
    const target = join(dir, "u.pdf");
    const err = await callDocumentsTool(facades(calls), { action: "receipt", receipt_id: "rcpt_u", out: target }).catch((e: unknown) => e);
    expect(documentsErrorText(err)).toBe("document_not_final: not yet");
    expect(existsSync(target)).toBe(false);
  });
});
