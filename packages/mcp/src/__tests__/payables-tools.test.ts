/**
 * `codespar_payables` over MCP: a closed schema, each action through the
 * `cs.payables` facade, `upload` only with local files allowed and only for
 * the accepted file types, and what returns to the model carries no item
 * description (document text) — ids, counts, masked destinations, amounts.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PayableBatch, Payables } from "@codespar/sdk";
import {
  callPayablesTool,
  isPayablesTool,
  payablesErrorText,
  payablesToolDefinition,
  projectBatch,
} from "../payables-tools.js";

const BATCH: PayableBatch = {
  batch_id: "pbat_example",
  status: "ready",
  version: 2,
  list_hash: "hash_v2",
  currency: "BRL",
  totals: { items: 1, payable_items: 1, excluded: 0, amount_minor: 12345 },
  confirmation: null,
  items: [
    {
      item_id: "pbl_AbCdEfGhIjKlMnOp",
      position: 0,
      origin: { file_id: "pfile_example", page: 1, row: null, kind: "boleto_line" },
      rail: "boleto",
      rail_chosen_by: "default",
      ways: [{ rail: "boleto", origin: { page: 1, kind: "boleto_line" }, destination: null, unavailable: null }],
      document: { title: "Boleto", issuer: "Text read from the document", due_date: "2026-10-30", amount_minor: 12345 },
      state: "ready",
      missing: [],
      destination: {
        kind: "boleto",
        display: "23790.0000 ... 1234",
        beneficiary_name: "Empresa de Teste",
        beneficiary_document_masked: "**.***.***/0001-**",
        due_date: "2026-10-30",
      },
      amount_minor: 12345,
      amount_source: "rail_quote",
      description: "Text read from the document",
      reference: null,
      checks: [{ code: "amount_matches_rail", status: "pass", message: "Amount from the rail" }],
      payment: null,
    },
  ],
  created_at: "2026-10-24T12:00:00.000Z",
  source: "mcp",
  conversation_id: null,
  discarded: null,
};

function fakePayables() {
  const calls: unknown[][] = [];
  const payables = {
    files: {
      upload: async (file: unknown, opts: unknown) => {
        calls.push(["upload", Buffer.isBuffer(file) ? (file as Buffer).toString() : file, opts]);
        return { file_id: "pfile_example", kind: "pdf", sha256: "0".repeat(64), size_bytes: 8, items_found: 1, unresolved: 0, expires_at: "x" };
      },
    },
    batches: {
      create: async (...a: unknown[]) => (calls.push(["create", ...a]), BATCH),
      get: async (...a: unknown[]) => (calls.push(["get", ...a]), BATCH),
      updateItem: async (...a: unknown[]) => (calls.push(["updateItem", ...a]), BATCH),
      addItems: async (...a: unknown[]) => (calls.push(["addItems", ...a]), BATCH),
      pay: async (...a: unknown[]) => (calls.push(["pay", ...a]), BATCH),
      discard: async (...a: unknown[]) => (calls.push(["discard", ...a]), { ...BATCH, status: "canceled", discarded: { at: "2026-10-28T10:00:00.000Z", items: 1 } }),
    },
  } as unknown as Payables;
  return { payables, calls };
}

describe("codespar_payables MCP tool", () => {
  it("is a closed schema; the hosted shape has no upload and no path", () => {
    const local = payablesToolDefinition(true);
    const hosted = payablesToolDefinition(false);
    expect(local.name).toBe("codespar_payables");
    expect(local.inputSchema.additionalProperties).toBe(false);
    const props = (s: typeof local) => s.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props(local).action!.enum).toEqual(["upload", "create_batch", "get", "update_item", "set_rail", "pay", "discard"]);
    expect(props(hosted).action!.enum).toEqual(["create_batch", "get", "update_item", "set_rail", "pay", "discard"]);
    expect(props(hosted).rail!.enum).toEqual(["pix", "boleto"]);
    expect(props(hosted).path).toBeUndefined();
    expect(JSON.stringify(local.inputSchema)).not.toMatch(/"url"/);
    expect(isPayablesTool("codespar_pay")).toBe(false);
  });

  it("routes each action to the facade and never returns the item description", async () => {
    const { payables, calls } = fakePayables();
    const out = (await callPayablesTool(
      payables,
      { action: "create_batch", file_ids: ["pfile_example"], items: [{ pix_key: "a@b.com", amount_minor: 500 }] },
      { allowLocalFiles: true },
    )) as { items: Array<Record<string, unknown>> };
    expect(calls[0]).toEqual([
      "create",
      { fileIds: ["pfile_example"], items: [{ pixKey: "a@b.com", amountMinor: 500 }], source: "mcp" },
      undefined,
    ]);
    expect(JSON.stringify(out)).not.toContain("Text read from the document");
    expect(out.items[0]!.destination).toEqual(BATCH.items[0]!.destination);
    // A Pix destination's FULL key (v1.1 rule 6b) never reaches the model: the masked display does.
    const pix = {
      ...BATCH,
      items: [{ ...BATCH.items[0]!, rail: "pix" as const, destination: { kind: "pix_key" as const, display: "chave •••• d1ca", beneficiary_name: "Pessoa", beneficiary_document_masked: "***.456.789-**", due_date: null, beneficiary_institution: "Banco Exemplo", key: "11c126de-7a60-4556-81e7-97c0b209d1ca" } }],
    };
    const projected = JSON.stringify(projectBatch(pix));
    expect(projected).not.toContain("11c126de-7a60-4556-81e7-97c0b209d1ca");
    expect(projected).toContain("chave •••• d1ca");
    expect(projected).toContain("Banco Exemplo");

    await callPayablesTool(payables, { action: "get", batch_id: "pbat_example" }, { allowLocalFiles: false });
    await callPayablesTool(
      payables,
      { action: "update_item", batch_id: "pbat_example", item_id: "pbl_AbCdEfGhIjKlMnOp", expected_version: 2, excluded: true },
      { allowLocalFiles: false },
    );
    // One bill, two ways (payables v1.1): set_rail is the chat tool's spelling of the same PATCH; update_item takes rail too.
    await callPayablesTool(
      payables,
      { action: "set_rail", batch_id: "pbat_example", item_id: "pbl_AbCdEfGhIjKlMnOp", expected_version: 3, rail: "boleto" },
      { allowLocalFiles: false },
    );
    await callPayablesTool(
      payables,
      { action: "update_item", batch_id: "pbat_example", item_id: "pbl_AbCdEfGhIjKlMnOp", expected_version: 4, rail: "pix" },
      { allowLocalFiles: false },
    );
    await callPayablesTool(
      payables,
      { action: "pay", batch_id: "pbat_example", version: 2, list_hash: "hash_v2", mandate_id: "mdt_example" },
      { allowLocalFiles: false },
    );
    expect(calls.slice(1)).toEqual([
      ["get", "pbat_example"],
      ["updateItem", "pbat_example", "pbl_AbCdEfGhIjKlMnOp", { expectedVersion: 2, excluded: true }],
      ["updateItem", "pbat_example", "pbl_AbCdEfGhIjKlMnOp", { expectedVersion: 3, rail: "boleto" }],
      ["updateItem", "pbat_example", "pbl_AbCdEfGhIjKlMnOp", { expectedVersion: 4, rail: "pix" }],
      ["pay", "pbat_example", { version: 2, listHash: "hash_v2", mandateId: "mdt_example" }],
    ]);
    await expect(
      callPayablesTool(payables, { action: "set_rail", batch_id: "pbat_example", item_id: "pbl_AbCdEfGhIjKlMnOp", expected_version: 3, rail: "ted" }, { allowLocalFiles: false }),
    ).rejects.toThrow(/rail must be pix or boleto/);
    await expect(
      callPayablesTool(payables, { action: "pay", batch_id: "pbat_example", list_hash: "h" }, { allowLocalFiles: false }),
    ).rejects.toThrow(/version must be an integer/);
  });

  it("discard sends nothing without confirm=true; with it, discards and shows the mark", async () => {
    const { payables, calls } = fakePayables();
    const asked = (await callPayablesTool(payables, { action: "discard", batch_id: "pbat_example" }, { allowLocalFiles: false })) as Record<string, unknown>;
    expect(asked.requires_confirmation).toBe(true);
    expect(String(asked.message)).toMatch(/Nothing was sent\./);
    expect(calls.map((c) => c[0])).toEqual(["get"]);
    const done = (await callPayablesTool(payables, { action: "discard", batch_id: "pbat_example", confirm: true }, { allowLocalFiles: false })) as Record<string, unknown>;
    expect(calls.map((c) => c[0])).toEqual(["get", "discard"]);
    expect(calls[1]).toEqual(["discard", "pbat_example"]);
    expect(done).toMatchObject({ status: "canceled", discarded: { items: 1 } });
  });

  it("upload reads an accepted local file only when local files are allowed", async () => {
    const { payables, calls } = fakePayables();
    const dir = mkdtempSync(join(tmpdir(), "codespar-mcp-"));
    const pdf = join(dir, "conta.pdf");
    writeFileSync(pdf, "%PDF-1.7");
    const secret = join(dir, "id_rsa");
    writeFileSync(secret, "not for upload");

    await expect(callPayablesTool(payables, { action: "upload", path: pdf }, { allowLocalFiles: false })).rejects.toThrow(
      /file_id/,
    );
    await expect(callPayablesTool(payables, { action: "upload", path: secret }, { allowLocalFiles: true })).rejects.toThrow(
      /accepts/,
    );
    const out = await callPayablesTool(payables, { action: "upload", path: pdf }, { allowLocalFiles: true });
    expect(calls).toEqual([["upload", "%PDF-1.7", { filename: "conta.pdf" }]]);
    expect(out).not.toHaveProperty("sha256");
    expect(out).toMatchObject({ file_id: "pfile_example", items_found: 1 });
  });

  it("a 409 tells the model the current version and list_hash to confirm", () => {
    const err = Object.assign(new Error("payables.batches.pay failed: 409 — The list changed"), {
      status: 409,
      body: {
        error: {
          code: "payable_batch_version_mismatch",
          message: "The list changed",
          details: { batch: { ...BATCH, version: 3, list_hash: "hash_v3" } },
        },
      },
    });
    const text = JSON.parse(payablesErrorText(err)) as { current_batch: { version: number; list_hash: string } };
    expect(text.current_batch).toMatchObject({ version: 3, list_hash: "hash_v3" });
    expect(payablesErrorText(new Error("403: forbidden"))).toBe("403: forbidden");
  });

  it("a 403 is said as a missing permission, with the API's words, and a 401 as a bad credential", () => {
    const forbidden = Object.assign(new Error("payables.batches.pay failed: 403 — API key does not have the 'payables:pay' scope."), {
      status: 403,
      body: { error: { code: "forbidden", message: "API key does not have the 'payables:pay' scope." } },
    });
    expect(payablesErrorText(forbidden)).toBe(
      "insufficient permission (403): API key does not have the 'payables:pay' scope. The key is valid; this one action needs a scope it does not carry.",
    );
    const flat = Object.assign(new Error("payables.files.upload failed: 403 — missing scope"), { status: 403, body: { message: "missing scope" } });
    expect(payablesErrorText(flat)).toMatch(/^insufficient permission \(403\): missing scope\./);
    const unauthorized = Object.assign(new Error("payables.files.upload failed: 401 — Invalid API key"), { status: 401 });
    expect(payablesErrorText(unauthorized)).toBe("credential invalid or revoked (401): payables.files.upload failed: 401 — Invalid API key");
  });
});
