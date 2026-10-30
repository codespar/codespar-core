/**
 * `codespar payables files|batches`: what each command sends through the
 * SDK facade (upload first, then the batch; snake_case on the wire;
 * `source: "cli"`), how `--item` is read, and that a 409 on pay shows the
 * current list before the error reaches the global handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseItemSpec,
  payablesBatchCreateCommand,
  payablesBatchDiscardCommand,
  payablesBatchPayCommand,
  payablesBatchUpdateItemCommand,
  payablesFilesUploadCommand,
} from "../commands/payables.js";
import { CliError } from "../config.js";

const AUTH = { apiKey: "csk_test_example", baseUrl: "https://api.example.test", json: true };

const FILE = {
  file_id: "pfile_example",
  kind: "pdf",
  sha256: "0".repeat(64),
  size_bytes: 16,
  items_found: 2,
  unresolved: 1,
  expires_at: "2026-10-25T12:00:00.000Z",
};

const BATCH = {
  batch_id: "pbat_example",
  status: "reviewing",
  version: 1,
  list_hash: "hash_v1",
  currency: "BRL",
  totals: { items: 1, payable_items: 1, excluded: 0, amount_minor: 5000 },
  confirmation: null,
  items: [],
  created_at: "2026-10-24T12:00:00.000Z",
  source: "cli",
  conversation_id: null,
  discarded: null,
};

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

let seen: Seen[] = [];
let answer: (s: Seen) => Response;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  seen = [];
  answer = (s) => respond(s.path.endsWith("/files") ? 201 : 200, s.path.endsWith("/files") ? FILE : BATCH);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s = {
      method: init.method ?? "GET",
      path: new URL(url).pathname,
      headers: init.headers as Record<string, string>,
      body: init.body,
    };
    seen.push(s);
    return answer(s);
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codespar-payables-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("--item", () => {
  it("reads key=value pairs and JSON into the facade's item", () => {
    expect(parseItemSpec("pix_key=pessoa@example.com,amount_minor=5000,reference=r1")).toEqual({
      pixKey: "pessoa@example.com",
      amountMinor: 5000,
      reference: "r1",
    });
    expect(parseItemSpec('{"boleto_line":"2379","description":"Luz, outubro"}')).toEqual({
      boletoLine: "2379",
      description: "Luz, outubro",
    });
  });

  it("refuses a bare Pix key without an amount, two carriers, and unknown keys", () => {
    expect(() => parseItemSpec("pix_key=pessoa@example.com")).toThrow(/never sets the amount/);
    expect(() => parseItemSpec("pix_key=a,br_code=b,amount_minor=1")).toThrow(/exactly one/);
    expect(() => parseItemSpec("amount=50.00,pix_key=a")).toThrow(CliError);
    expect(() => parseItemSpec("pix_key=a,amount_minor=50.00")).toThrow(/minor units/);
  });
});

describe("payables commands", () => {
  it("files upload sends the file bytes as one multipart part named after the path", async () => {
    const path = tempFile("conta.pdf", "%PDF-1.7 example");
    await payablesFilesUploadCommand(path, AUTH);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/v1/payables/files");
    const form = await new Request("https://x.test", { method: "POST", body: seen[0]!.body }).formData();
    const part = form.get("file") as File;
    expect(part.name).toBe("conta.pdf");
    expect(await part.text()).toBe("%PDF-1.7 example");
  });

  it("batches create uploads each --file, then creates with every file id and item", async () => {
    const path = tempFile("lote.csv", "pix_key,amount_minor\na@b.com,100\n");
    await payablesBatchCreateCommand({
      ...AUTH,
      file: [path],
      fileId: ["pfile_earlier"],
      item: ["br_code=000201example"],
      idempotencyKey: "idem_example_0001",
    });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /v1/payables/files",
      "POST /v1/payables/batches",
    ]);
    expect(seen[1]!.headers["Idempotency-Key"]).toBe("idem_example_0001");
    expect(JSON.parse(String(seen[1]!.body))).toEqual({
      file_ids: ["pfile_earlier", "pfile_example"],
      items: [{ br_code: "000201example" }],
      source: "cli",
    });
  });

  it("batches create refuses an empty batch before any request", async () => {
    await expect(payablesBatchCreateCommand({ ...AUTH, file: [], fileId: [], item: [] })).rejects.toThrow(
      /at least one/,
    );
    expect(seen).toHaveLength(0);
  });

  it("update-item sends the expected version and only the fields passed", async () => {
    await payablesBatchUpdateItemCommand("pbat_example", "pay_example", {
      ...AUTH,
      expectedVersion: "1",
      amount: "5000",
      exclude: false,
    });
    await payablesBatchUpdateItemCommand("pbat_example", "pay_example", {
      ...AUTH,
      expectedVersion: "2",
      exclude: true,
    });
    expect(seen[0]!.path).toBe("/v1/payables/batches/pbat_example/items/pay_example");
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ expected_version: 1, amount_minor: 5000 });
    expect(JSON.parse(String(seen[1]!.body))).toEqual({ expected_version: 2, excluded: true });
    await expect(
      payablesBatchUpdateItemCommand("pbat_example", "pay_example", { ...AUTH, expectedVersion: "2" }),
    ).rejects.toThrow(/Nothing to change/);
  });

  it("update-item --rail chooses the way of a bill printed with Pix and boleto (payables v1.1); anything else is refused before any request", async () => {
    await payablesBatchUpdateItemCommand("pbat_example", "pay_example", { ...AUTH, expectedVersion: "3", rail: "boleto" });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ expected_version: 3, rail: "boleto" });
    await expect(
      payablesBatchUpdateItemCommand("pbat_example", "pay_example", { ...AUTH, expectedVersion: "3", rail: "ted" }),
    ).rejects.toThrow(/--rail must be pix or boleto/);
    expect(seen).toHaveLength(1);
  });

  it("pay binds to the batch version and list hash, with the mandate", async () => {
    await payablesBatchPayCommand("pbat_example", {
      ...AUTH,
      batchVersion: "1",
      listHash: "hash_v1",
      mandate: "mdt_example",
    });
    expect(seen[0]!.path).toBe("/v1/payables/batches/pbat_example/pay");
    expect(JSON.parse(String(seen[0]!.body))).toEqual({
      version: 1,
      list_hash: "hash_v1",
      mandate_id: "mdt_example",
    });
    expect(seen[0]!.headers["Idempotency-Key"]).toBe("pay:pbat_example:1:hash_v1");
  });

  it("discard sends nothing without --confirm: it reads the batch and says what would leave", async () => {
    const err = await payablesBatchDiscardCommand("pbat_example", { ...AUTH }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String((err as Error).message)).toMatch(/Pass --confirm to discard\. Nothing was sent\./);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/payables/batches/pbat_example"]);
  });

  it("discard with --confirm posts an empty object to the discard door", async () => {
    await payablesBatchDiscardCommand("pbat_example", { ...AUTH, confirm: true });
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /v1/payables/batches/pbat_example/discard"]);
    expect(JSON.parse(String(seen[0]!.body))).toEqual({});
  });

  it("pay on a changed list shows the new version and hash, then fails", async () => {
    answer = () =>
      respond(409, {
        error: {
          code: "payable_batch_version_mismatch",
          message: "The list changed",
          details: { batch: { ...BATCH, version: 2, list_hash: "hash_v2" } },
        },
      });
    const err = await payablesBatchPayCommand("pbat_example", {
      ...AUTH,
      json: false,
      batchVersion: "1",
      listHash: "hash_v1",
    }).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("payable_batch_version_mismatch");
    const printed = [process.stdout.write, process.stderr.write]
      .flatMap((w) => vi.mocked(w).mock.calls.map((c) => String(c[0])))
      .join("");
    expect(printed).toContain("--batch-version 2 --list-hash hash_v2");
  });
});
