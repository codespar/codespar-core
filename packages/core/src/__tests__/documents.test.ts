/**
 * `cs.receipts.document` and `cs.account.statement`: the request each one
 * sends (path, format, auth and project headers, Accept), what comes back
 * (bytes, content type, the server's filename, the content hash), and the
 * refusals as `CodesparApiError` with the API's code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeSpar, CodesparApiError, filenameFromDisposition } from "../index.js";

const BASE = "https://api.example.test";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}
let seen: Seen[] = [];
let answer: (s: Seen) => Response;

/** A fresh ArrayBuffer copy: `Response` wants `BodyInit`, and a `Uint8Array<ArrayBufferLike>` is not one. */
function body(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function binary(bytes: Uint8Array, type: string, filename: string, sha = "a".repeat(64)): Response {
  return new Response(body(bytes), {
    status: 200,
    headers: { "content-type": type, "content-disposition": `attachment; filename="${filename}"`, "x-codespar-document-sha256": sha },
  });
}

function refusal(status: number, code: string, details?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: { code, message: code, ...(details ? { details } : {}) }, request_id: "req_1" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function install() {
  seen = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s = { url, method: init.method ?? "GET", headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) };
    seen.push(s);
    return answer(s);
  });
  return new CodeSpar({ apiKey: "csk_test_example", baseUrl: BASE, projectId: "prj_abc123DEF456ghi7" });
}

afterEach(() => vi.unstubAllGlobals());

describe("cs.receipts.document", () => {
  it("GETs the receipt document with the format, the bearer and the project, and returns the bytes with the server's name and hash", async () => {
    const cs = install();
    answer = () => binary(PDF, "application/pdf", "comprovante-rcpt_x.pdf");
    const doc = await cs.receipts.document("rcpt_x");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}/v1/consumers/receipts/rcpt_x/document?format=pdf`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer csk_test_example");
    expect(seen[0]!.headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
    expect(seen[0]!.headers["accept"]).toContain("application/pdf");
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.filename).toBe("comprovante-rcpt_x.pdf");
    expect(doc.sha256).toBe("a".repeat(64));
    expect(Array.from(doc.bytes)).toEqual(Array.from(PDF));
  });

  it("png: the same route with format=png, image/png accepted", async () => {
    const cs = install();
    answer = () => binary(PNG, "image/png", "comprovante-rcpt_x.png");
    const doc = await cs.receipts.document("rcpt_x", { format: "png" });
    expect(seen[0]!.url).toBe(`${BASE}/v1/consumers/receipts/rcpt_x/document?format=png`);
    expect(seen[0]!.headers["accept"]).toContain("image/png");
    expect(doc.contentType).toBe("image/png");
    expect(doc.bytes[0]).toBe(0x89);
  });

  it("a payment that is not final: CodesparApiError 409 document_not_final with the attempt's status", async () => {
    const cs = install();
    answer = () => refusal(409, "document_not_final", { attempt_id: "att_1", status: "uncertain" });
    const err = await cs.receipts.document("rcpt_u").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err).toMatchObject({ status: 409, code: "document_not_final" });
  });

  it("refuses locally an empty id or a format it does not know, without a request", async () => {
    const cs = install();
    expect(() => cs.receipts.document("")).toThrow(CodesparApiError);
    expect(() => cs.receipts.document("rcpt_x", { format: "docx" as "pdf" })).toThrow(CodesparApiError);
    expect(seen).toHaveLength(0);
  });

  it("falls back to its own filename when the server sends no disposition", async () => {
    const cs = install();
    answer = () => new Response(body(PDF), { status: 200, headers: { "content-type": "application/pdf" } });
    const doc = await cs.receipts.document("rcpt_x");
    expect(doc.filename).toBe("comprovante-rcpt_x.pdf");
    expect(doc.sha256).toBeNull();
  });
});

describe("cs.account.statement", () => {
  it("GETs the statement of the period as PDF", async () => {
    const cs = install();
    answer = () => binary(PDF, "application/pdf", "extrato-2026-09-01-2026-09-30.pdf", "b".repeat(64));
    const doc = await cs.account.statement({ from: "2026-09-01", to: "2026-09-30" });
    expect(seen[0]!.url).toBe(`${BASE}/v1/account/statement?from=2026-09-01&to=2026-09-30&format=pdf`);
    expect(doc.filename).toBe("extrato-2026-09-01-2026-09-30.pdf");
    expect(doc.sha256).toBe("b".repeat(64));
    expect(doc.pages).toBeNull();
  });

  it("png: one page by its number, image/png accepted, the page count read from X-CodeSpar-Document-Pages", async () => {
    const cs = install();
    answer = () => {
      const r = binary(PNG, "image/png", "extrato-2026-09-01-2026-09-30-p2.png", "c".repeat(64));
      r.headers.set("x-codespar-document-pages", "3");
      return r;
    };
    const doc = await cs.account.statement({ from: "2026-09-01", to: "2026-09-30", format: "png", page: 2 });
    expect(seen[0]!.url).toBe(`${BASE}/v1/account/statement?from=2026-09-01&to=2026-09-30&format=png&page=2`);
    expect(seen[0]!.headers["accept"]).toContain("image/png");
    expect(doc.contentType).toBe("image/png");
    expect(doc.filename).toBe("extrato-2026-09-01-2026-09-30-p2.png");
    expect(doc.pages).toBe(3);
    expect(Array.from(doc.bytes)).toEqual(Array.from(PNG));
  });

  it("png without a page asks for page 1; without a count header, pages is null", async () => {
    const cs = install();
    answer = () => new Response(body(PNG), { status: 200, headers: { "content-type": "image/png" } });
    const doc = await cs.account.statement({ from: "2026-09-01", to: "2026-09-30", format: "png", currency: "BRL" });
    expect(seen[0]!.url).toBe(`${BASE}/v1/account/statement?from=2026-09-01&to=2026-09-30&format=png&page=1&currency=BRL`);
    expect(doc.filename).toBe("extrato-2026-09-01-2026-09-30-p1.png");
    expect(doc.pages).toBeNull();
  });

  it("a page past the end: CodesparApiError 404 statement_page_not_found with the page asked and the count", async () => {
    const cs = install();
    answer = () => refusal(404, "statement_page_not_found", { page: 4, pages: 3 });
    const err = await cs.account.statement({ from: "2026-09-01", to: "2026-09-30", format: "png", page: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err).toMatchObject({ status: 404, code: "statement_page_not_found", body: { error: { details: { page: 4, pages: 3 } } } });
  });

  it("carries the currency when given, and relays the period refusal", async () => {
    const cs = install();
    answer = () => refusal(400, "statement_period_invalid", { reason: "too_long" });
    const err = await cs.account.statement({ from: "2026-01-01", to: "2026-09-30", currency: "BRL" }).catch((e: unknown) => e);
    expect(seen[0]!.url).toBe(`${BASE}/v1/account/statement?from=2026-01-01&to=2026-09-30&format=pdf&currency=BRL`);
    expect(err).toMatchObject({ status: 400, code: "statement_period_invalid" });
  });

  it("refuses locally without from/to, a format it does not know, or a page that is not a whole number from 1 with png", () => {
    const cs = install();
    const period = { from: "2026-09-01", to: "2026-09-30" };
    expect(() => cs.account.statement({ from: "", to: "2026-09-30" })).toThrow(CodesparApiError);
    expect(() => cs.account.statement({ ...period, format: "docx" as "pdf" })).toThrow(CodesparApiError);
    for (const page of [0, -1, 1.5, Number.NaN]) expect(() => cs.account.statement({ ...period, format: "png", page })).toThrow(CodesparApiError);
    expect(() => cs.account.statement({ ...period, page: 2 })).toThrow(/with format png/);
    expect(seen).toHaveLength(0);
  });
});

describe("filenameFromDisposition", () => {
  it("reads a quoted or bare filename and refuses a path", () => {
    expect(filenameFromDisposition('attachment; filename="comprovante-rcpt_x.pdf"')).toBe("comprovante-rcpt_x.pdf");
    expect(filenameFromDisposition("attachment; filename=extrato.pdf")).toBe("extrato.pdf");
    expect(filenameFromDisposition('attachment; filename="../x.pdf"')).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
