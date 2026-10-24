/**
 * `cs.payables`: the wire each call sends to /v1/payables/files and
 * /v1/payables/batches (snake_case, Idempotency-Key, multipart with a
 * boundary), and that a 409 carrying the current batch surfaces as an
 * error the caller can read the new list from, never as a success.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { CodeSpar, CodesparApiError, payableBatchFromError, type PayableBatch } from "../index.js";

const BASE = "https://api.example.test";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BATCH: PayableBatch = {
  batch_id: "pbat_example",
  status: "ready",
  version: 3,
  list_hash: "hash_v3",
  currency: "BRL",
  totals: { items: 1, payable_items: 1, excluded: 0, amount_minor: 5000 },
  confirmation: null,
  items: [
    {
      item_id: "pbl_AbCdEfGhIjKlMnOp",
      position: 0,
      origin: { file_id: null, page: null, row: null, kind: "manual" },
      rail: "pix",
      state: "ready",
      missing: [],
      destination: {
        kind: "pix_key",
        display: "***.456.789-**",
        beneficiary_name: "Pessoa de Teste",
        beneficiary_document_masked: "***.456.789-**",
        due_date: null,
      },
      amount_minor: 5000,
      amount_source: "stated_by_person",
      description: "Aluguel",
      reference: null,
      checks: [{ code: "pix_key_resolved", status: "pass", message: "Chave encontrada" }],
      payment: null,
    },
  ],
  created_at: "2026-10-24T12:00:00.000Z",
  source: "api",
  conversation_id: null,
};

function client(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body,
    };
    seen.push(s);
    return answer(s);
  });
  const cs = new CodeSpar({ apiKey: "csk_test_example", baseUrl: BASE, projectId: "prj_abc123DEF456ghi7" });
  return { cs, seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILE = {
  file_id: "pfile_example",
  kind: "pdf",
  sha256: "0".repeat(64),
  size_bytes: 16,
  items_found: 1,
  unresolved: 0,
  expires_at: "2026-10-25T12:00:00.000Z",
};

async function partOf(s: Seen): Promise<{ contentType: string | null; file: File }> {
  const req = new Request(s.url, { method: "POST", body: s.body });
  const form = await req.formData();
  return { contentType: req.headers.get("content-type"), file: form.get("file") as File };
}

describe("cs.payables.files.upload", () => {
  it("posts one multipart part named file, with the boundary fetch writes", async () => {
    const { cs, seen } = client(() => json(201, FILE));
    const bytes = new TextEncoder().encode("%PDF-1.7 example");
    const file = await cs.payables.files.upload(new File([bytes], "conta.pdf", { type: "application/pdf" }));

    expect(file).toEqual(FILE);
    expect(seen[0]!.url).toBe(`${BASE}/v1/payables/files`);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.headers["Content-Type"]).toBeUndefined();
    expect(seen[0]!.headers.Authorization).toBe("Bearer csk_test_example");
    expect(seen[0]!.headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
    const { contentType, file: part } = await partOf(seen[0]!);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(part.name).toBe("conta.pdf");
    expect(part.type).toBe("application/pdf");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes);
  });

  it("accepts a Buffer, a Node stream and a web stream, with filename and type from the options", async () => {
    const { cs, seen } = client(() => json(201, FILE));
    await cs.payables.files.upload(Buffer.from("a,b\n1,2\n"), { filename: "lote.csv", contentType: "text/csv" });
    await cs.payables.files.upload(Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]), {
      filename: "lote.csv",
    });
    await cs.payables.files.upload(new Blob(["a,b\n1,2\n"]).stream());

    const parts = await Promise.all(seen.map(partOf));
    for (const { file } of parts) expect(await file.text()).toBe("a,b\n1,2\n");
    expect(parts.map((p) => p.file.name)).toEqual(["lote.csv", "lote.csv", "document"]);
    expect(parts[0]!.file.type).toBe("text/csv");
  });

  it("surfaces 413 payable_file_too_large as CodesparApiError with the code", async () => {
    const { cs } = client(() =>
      json(413, { error: { code: "payable_file_too_large", message: "Over 10 MB" }, request_id: "req_example" }),
    );
    const err = await cs.payables.files.upload(new Blob(["x"])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect((err as CodesparApiError).status).toBe(413);
    expect((err as CodesparApiError).code).toBe("payable_file_too_large");
  });
});

describe("cs.payables.batches", () => {
  it("create sends snake_case items and an Idempotency-Key, the caller's when given", async () => {
    const { cs, seen } = client(() => json(201, BATCH));
    const batch = await cs.payables.batches.create(
      {
        fileIds: ["pfile_example"],
        items: [{ pixKey: "pessoa@example.com", amountMinor: 5000, description: "Aluguel", reference: "ref-1" }],
        source: "cli",
      },
      { idempotencyKey: "idem_example_0001" },
    );
    expect(batch).toEqual(BATCH);
    expect(seen[0]!.url).toBe(`${BASE}/v1/payables/batches`);
    expect(seen[0]!.headers["Idempotency-Key"]).toBe("idem_example_0001");
    expect(seen[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]!.body))).toEqual({
      file_ids: ["pfile_example"],
      items: [{ pix_key: "pessoa@example.com", amount_minor: 5000, description: "Aluguel", reference: "ref-1" }],
      source: "cli",
    });
  });

  it("create without a key still sends one, a fresh one per call", async () => {
    const { cs, seen } = client(() => json(201, BATCH));
    await cs.payables.batches.create({ items: [{ boletoLine: "23790000000000000000000000000000000000000000000" }] });
    await cs.payables.batches.create({ items: [{ brCode: "000201example" }] });
    const keys = seen.map((s) => s.headers["Idempotency-Key"]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("get, updateItem and addItems reach their paths with the expected version", async () => {
    const { cs, seen } = client(() => json(200, BATCH));
    await cs.payables.batches.get("pbat_example");
    await cs.payables.batches.updateItem("pbat_example", "pbl_AbCdEfGhIjKlMnOp", { expectedVersion: 3, amountMinor: 5000 });
    await cs.payables.batches.updateItem("pbat_example", "pbl_AbCdEfGhIjKlMnOp", { expectedVersion: 4, excluded: true });
    await cs.payables.batches.addItems("pbat_example", {
      expectedVersion: 5,
      items: [{ pixKey: "+5511999990000", amountMinor: 1200 }],
    });

    expect(seen.map((s) => `${s.method} ${s.url.slice(BASE.length)}`)).toEqual([
      "GET /v1/payables/batches/pbat_example",
      "PATCH /v1/payables/batches/pbat_example/items/pbl_AbCdEfGhIjKlMnOp",
      "PATCH /v1/payables/batches/pbat_example/items/pbl_AbCdEfGhIjKlMnOp",
      "POST /v1/payables/batches/pbat_example/items",
    ]);
    expect(seen[0]!.body).toBeUndefined();
    expect(JSON.parse(String(seen[1]!.body))).toEqual({ expected_version: 3, amount_minor: 5000 });
    expect(JSON.parse(String(seen[2]!.body))).toEqual({ expected_version: 4, excluded: true });
    expect(JSON.parse(String(seen[3]!.body))).toEqual({
      expected_version: 5,
      items: [{ pix_key: "+5511999990000", amount_minor: 1200 }],
    });
  });

  it("pay binds to version and list_hash with a key derived from them", async () => {
    const { cs, seen } = client(() => json(200, { ...BATCH, status: "completed" }));
    await cs.payables.batches.pay("pbat_example", { version: 3, listHash: "hash_v3", mandateId: "mdt_example" });
    await cs.payables.batches.pay("pbat_example", { version: 3, listHash: "hash_v3", mandateId: "mdt_example" });
    expect(seen[0]!.url).toBe(`${BASE}/v1/payables/batches/pbat_example/pay`);
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ version: 3, list_hash: "hash_v3", mandate_id: "mdt_example" });
    expect(seen[0]!.headers["Idempotency-Key"]).toBe("pay:pbat_example:3:hash_v3");
    expect(seen[1]!.headers["Idempotency-Key"]).toBe(seen[0]!.headers["Idempotency-Key"]);
  });

  it("a 409 version mismatch is an error that carries the current batch", async () => {
    const current = { ...BATCH, version: 4, list_hash: "hash_v4" };
    const { cs } = client(() =>
      json(409, {
        error: { code: "payable_batch_version_mismatch", message: "The list changed", details: { batch: current } },
        request_id: "req_example",
      }),
    );
    const err = await cs.payables.batches
      .pay("pbat_example", { version: 3, listHash: "hash_v3" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect((err as CodesparApiError).code).toBe("payable_batch_version_mismatch");
    expect((err as CodesparApiError).message).toContain("The list changed");
    expect(payableBatchFromError(err)).toEqual(current);
    expect(payableBatchFromError(new Error("other"))).toBeUndefined();
  });
});
