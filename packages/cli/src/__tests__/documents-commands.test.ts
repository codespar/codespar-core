/**
 * `codespar receipts document` and `codespar account statement`: the request
 * each one sends through the SDK, the file it writes (to --out or to the
 * server's filename), the --json record, and the local refusals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountStatementCommand, receiptsDocumentCommand } from "../commands/documents.js";
import { CliError } from "../config.js";

const AUTH = { apiKey: "csk_test_example", baseUrl: "https://api.example.test", project: "prj_abc123DEF456ghi7", json: true };
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

interface Seen {
  url: string;
  headers: Record<string, string>;
}
let seen: Seen[] = [];
let answer: (s: Seen) => Response;
let printed: unknown[] = [];
let dir: string;
let cwd: string;

/** A fresh ArrayBuffer copy: `Response` wants `BodyInit`, and a `Buffer` (a `Uint8Array<ArrayBufferLike>`) is not one. */
function body(bytes: Buffer): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

function binary(bytes: Buffer, type: string, filename: string): Response {
  return new Response(body(bytes), { status: 200, headers: { "content-type": type, "content-disposition": `attachment; filename="${filename}"`, "x-codespar-document-sha256": "c".repeat(64) } });
}

beforeEach(() => {
  seen = [];
  printed = [];
  dir = mkdtempSync(join(tmpdir(), "codespar-docs-"));
  cwd = process.cwd();
  process.chdir(dir);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s = { url, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) };
    seen.push(s);
    return answer(s);
  });
  // `json()` writes to stdout, not console.log (output.ts).
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    printed.push(chunk);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastJson(): Record<string, unknown> {
  const text = printed.map(String).join("");
  const start = text.lastIndexOf("\n{");
  return JSON.parse(text.slice(start < 0 ? 0 : start + 1)) as Record<string, unknown>;
}

describe("codespar receipts document", () => {
  it("writes the PDF to --out and prints the record", async () => {
    answer = () => binary(PDF, "application/pdf", "comprovante-rcpt_x.pdf");
    const out = join(dir, "sub.pdf");
    await receiptsDocumentCommand("rcpt_x", { ...AUTH, out });
    expect(seen[0]!.url).toBe("https://api.example.test/v1/consumers/receipts/rcpt_x/document?format=pdf");
    expect(seen[0]!.headers["authorization"]).toBe("Bearer csk_test_example");
    expect(seen[0]!.headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
    expect(readFileSync(out).equals(PDF)).toBe(true);
    expect(lastJson()).toMatchObject({ kind: "receipt", receipt_id: "rcpt_x", format: "pdf", path: out, filename: "comprovante-rcpt_x.pdf", content_type: "application/pdf", bytes: PDF.length, sha256: "c".repeat(64) });
  });

  it("png without --out lands under the server's filename in the current directory", async () => {
    answer = () => binary(PNG, "image/png", "comprovante-rcpt_x.png");
    await receiptsDocumentCommand("rcpt_x", { ...AUTH, format: "png" });
    expect(seen[0]!.url).toContain("format=png");
    expect(existsSync(join(dir, "comprovante-rcpt_x.png"))).toBe(true);
    expect(lastJson()).toMatchObject({ format: "png", filename: "comprovante-rcpt_x.png" });
  });

  it("refuses a missing id or an unknown format before any request", async () => {
    await expect(receiptsDocumentCommand("", AUTH)).rejects.toBeInstanceOf(CliError);
    await expect(receiptsDocumentCommand("rcpt_x", { ...AUTH, format: "docx" })).rejects.toBeInstanceOf(CliError);
    expect(seen).toHaveLength(0);
  });

  it("relays the API's refusal (409 document_not_final) and writes nothing", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "document_not_final", message: "not yet" } }), { status: 409, headers: { "content-type": "application/json" } });
    await expect(receiptsDocumentCommand("rcpt_u", { ...AUTH, out: join(dir, "u.pdf") })).rejects.toMatchObject({ status: 409, code: "document_not_final" });
    expect(existsSync(join(dir, "u.pdf"))).toBe(false);
  });
});

describe("codespar account statement", () => {
  it("writes the statement of the period and prints the record", async () => {
    answer = () => binary(PDF, "application/pdf", "extrato-2026-09-01-2026-09-30.pdf");
    await accountStatementCommand({ ...AUTH, from: "2026-09-01", to: "2026-09-30" });
    expect(seen[0]!.url).toBe("https://api.example.test/v1/account/statement?from=2026-09-01&to=2026-09-30&format=pdf");
    expect(existsSync(join(dir, "extrato-2026-09-01-2026-09-30.pdf"))).toBe(true);
    expect(lastJson()).toMatchObject({ kind: "statement", from: "2026-09-01", to: "2026-09-30", format: "pdf" });
  });

  it("refuses a malformed or inverted period before any request", async () => {
    await expect(accountStatementCommand({ ...AUTH, from: "2026-9-1", to: "2026-09-30" })).rejects.toBeInstanceOf(CliError);
    await expect(accountStatementCommand({ ...AUTH, from: "2026-09-30", to: "2026-09-01" })).rejects.toBeInstanceOf(CliError);
    await expect(accountStatementCommand({ ...AUTH, to: "2026-09-01" })).rejects.toBeInstanceOf(CliError);
    expect(seen).toHaveLength(0);
  });
});
