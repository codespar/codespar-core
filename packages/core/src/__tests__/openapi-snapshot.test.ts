/**
 * The generated client is only as true as the chain behind it:
 *
 *   served document == openapi-snapshot.json   (scripts/openapi-spec.mjs check, network)
 *   openapi-snapshot.json == src/generated/*    (this file, hermetic)
 *   src/generated/operations.ts == paths type   (tsc, via `satisfies`)
 *   every row of the table is dispatchable      (api-client.test.ts)
 *
 * This file pins the hermetic links and proves the comparison itself can
 * fail: a snapshot with one operation removed must be reported as drift.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  OPERATIONS_PATH,
  SNAPSHOT_PATH,
  TYPES_PATH,
  diffOperations,
  documentSha256,
  listOperations,
  operationTable,
  readSnapshot,
  renderGenerated,
} from "../../scripts/openapi-spec.mjs";
import { API_OPERATIONS } from "../generated/operations.js";
import { ApiClient } from "../api/client.js";

const snapshot = readSnapshot(SNAPSHOT_PATH);
const key = (op: { method: string; path: string }) => `${op.method.toUpperCase()} ${op.path}`;

describe("openapi-snapshot.json", () => {
  it("records the sha256 of its own document (a hand edit breaks the seal)", () => {
    expect(documentSha256(snapshot.document)).toBe(snapshot.snapshot.sha256);
  });

  it("records its own operation and path counts", () => {
    expect(listOperations(snapshot.document)).toHaveLength(snapshot.snapshot.operations);
    expect(Object.keys(snapshot.document.paths ?? {})).toHaveLength(snapshot.snapshot.paths);
  });

  it("names the served URL and a fetch timestamp", () => {
    expect(snapshot.snapshot.source).toMatch(/^https:\/\/.+\/openapi\.json$/);
    expect(new Date(snapshot.snapshot.fetched_at).toString()).not.toBe("Invalid Date");
  });
});

describe("src/generated/", () => {
  it("equals what the snapshot generates (no hand edits, no stale output)", async () => {
    const rendered = await renderGenerated(snapshot);
    expect(fs.readFileSync(TYPES_PATH, "utf8")).toBe(rendered.types);
    expect(fs.readFileSync(OPERATIONS_PATH, "utf8")).toBe(rendered.operations);
  });

  it("carries every operation of the snapshot, once, in document order", () => {
    const fromSnapshot = operationTable(snapshot.document);
    expect(API_OPERATIONS.map(key)).toEqual(fromSnapshot.map(key));
    expect(new Set(API_OPERATIONS.map(key)).size).toBe(API_OPERATIONS.length);
    expect([...API_OPERATIONS]).toEqual(fromSnapshot);
  });

  it("is what the client enumerates as reachable", () => {
    expect(ApiClient.operations().map(key)).toEqual(API_OPERATIONS.map(key));
  });
});

describe("diffOperations (the comparison the served check relies on)", () => {
  it("reports nothing for an identical document", () => {
    expect(diffOperations(snapshot.document, snapshot.document)).toEqual({
      added: [],
      removed: [],
      changed: [],
      schemas: [],
    });
  });

  it("goes red when one operation is removed from the snapshot (positive control)", () => {
    const first = listOperations(snapshot.document)[0]!;
    const edited = structuredClone(snapshot.document);
    delete edited.paths![first.path]![first.method];
    const diff = diffOperations(edited, snapshot.document);
    expect(diff.added).toEqual([key(first)]);
    expect(diff.removed).toEqual([]);
    expect(documentSha256(edited)).not.toBe(snapshot.snapshot.sha256);
  });

  it("reports an operation whose definition changed, and a schema that changed", () => {
    const edited = structuredClone(snapshot.document);
    const wallet = edited.paths!["/v1/wallets/{id}"]!.get as Record<string, unknown>;
    wallet.description = "edited";
    (edited.components!.schemas!.Wallet as Record<string, unknown>).description = "edited";
    const diff = diffOperations(snapshot.document, edited);
    expect(diff.changed).toEqual(["GET /v1/wallets/{id}"]);
    expect(diff.schemas).toEqual(["Wallet"]);
  });
});
