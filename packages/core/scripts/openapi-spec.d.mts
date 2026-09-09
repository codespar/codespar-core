// Hand-written declarations for the generator script, so the vitest
// suite can import its pure helpers under `strict` without allowJs.

export interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface SnapshotMeta {
  source: string;
  fetched_at: string;
  sha256: string;
  etag: string | null;
  last_modified: string | null;
  info: { title: string | null; version: string | null };
  paths: number;
  operations: number;
  generator: string;
}

export interface Snapshot {
  snapshot: SnapshotMeta;
  document: OpenApiDocument;
}

export interface OperationEntry {
  method: string;
  path: string;
  operation: Record<string, unknown>;
}

export interface OperationRow {
  method: string;
  path: string;
  body: string | null;
  accept: string | null;
}

export interface OperationDiff {
  added: string[];
  removed: string[];
  changed: string[];
  schemas: string[];
}

export const SPEC_URL: string;
export const SNAPSHOT_PATH: string;
export const TYPES_PATH: string;
export const OPERATIONS_PATH: string;

export function documentSha256(document: OpenApiDocument): string;
export function listOperations(document: OpenApiDocument): OperationEntry[];
export function operationTable(document: OpenApiDocument): OperationRow[];
export function diffOperations(before: OpenApiDocument, after: OpenApiDocument): OperationDiff;
export function buildSnapshot(
  document: OpenApiDocument,
  meta: { source: string; fetchedAt: string; etag?: string | null; lastModified?: string | null },
): Snapshot;
export function renderGenerated(snapshot: Snapshot): Promise<{ types: string; operations: string }>;
export function readSnapshot(file?: string): Snapshot;
export function fetchServed(
  url?: string,
): Promise<{ document: OpenApiDocument; etag: string | null; lastModified: string | null }>;
