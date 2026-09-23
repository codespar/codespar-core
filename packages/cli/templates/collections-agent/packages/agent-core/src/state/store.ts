/**
 * Section 10: local state in `.codespar/state.db` (SQLite, via `node:sqlite`,
 * so there is no native build step). Executions and their states, the
 * append-only event log, the event cursor, the outbox with its
 * `idempotency_key`, the approval artifacts, and two stub tables the
 * sandbox stubs persist into so a killed process finds them again.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Execution, ExecutionState } from "../state-machine.js";
import type { ApprovalArtifact } from "../types.js";

export interface EventRow {
  seq: number;
  run_id: string;
  execution_id: string | null;
  type: string;
  payload: unknown;
  at: string;
}

export type OutboxStatus = "pending" | "sent" | "done" | "failed";

export interface OutboxRow {
  idempotency_key: string;
  execution_id: string;
  kind: string;
  payload: unknown;
  status: OutboxStatus;
  response: unknown;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executions_run ON executions(run_id);
CREATE INDEX IF NOT EXISTS executions_state ON executions(state);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  execution_id TEXT,
  event_id TEXT UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  idempotency_key TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stub_rail_attempts (
  attempt_id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stub_mandate_status (
  mandate_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stub_org (
  org_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`;

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // executions

  saveExecution(execution: Execution): void {
    this.db
      .prepare(
        `INSERT INTO executions (id, run_id, state, mandate_id, json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(execution.id, execution.run_id, execution.state, execution.mandate.id, JSON.stringify(execution), execution.created_at, execution.updated_at);
  }

  getExecution(id: string): Execution | undefined {
    const row = this.db.prepare("SELECT json FROM executions WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Execution) : undefined;
  }

  listExecutions(filter: { run_id?: string; state?: ExecutionState | ExecutionState[]; mandate_id?: string } = {}): Execution[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.run_id) {
      where.push("run_id = ?");
      args.push(filter.run_id);
    }
    if (filter.mandate_id) {
      where.push("mandate_id = ?");
      args.push(filter.mandate_id);
    }
    if (filter.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state];
      where.push(`state IN (${states.map(() => "?").join(",")})`);
      args.push(...states);
    }
    const sql = `SELECT json FROM executions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`;
    return (this.db.prepare(sql).all(...args) as { json: string }[]).map((r) => JSON.parse(r.json) as Execution);
  }

  // events

  appendEvent(event: { run_id: string; execution_id?: string | null; event_id?: string; type: string; payload: unknown; at: string }): EventRow | undefined {
    if (event.event_id) {
      const dup = this.db.prepare("SELECT seq FROM events WHERE event_id = ?").get(event.event_id);
      if (dup) return undefined;
    }
    const result = this.db
      .prepare("INSERT INTO events (run_id, execution_id, event_id, type, payload, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.run_id, event.execution_id ?? null, event.event_id ?? null, event.type, JSON.stringify(event.payload ?? null), event.at);
    return { seq: Number(result.lastInsertRowid), run_id: event.run_id, execution_id: event.execution_id ?? null, type: event.type, payload: event.payload, at: event.at };
  }

  listEvents(filter: { run_id?: string; execution_id?: string; after_seq?: number } = {}): EventRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.run_id) {
      where.push("run_id = ?");
      args.push(filter.run_id);
    }
    if (filter.execution_id) {
      where.push("execution_id = ?");
      args.push(filter.execution_id);
    }
    if (filter.after_seq !== undefined) {
      where.push("seq > ?");
      args.push(filter.after_seq);
    }
    const sql = `SELECT seq, run_id, execution_id, type, payload, at FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq`;
    return (this.db.prepare(sql).all(...args) as Array<Omit<EventRow, "payload"> & { payload: string }>).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  getCursor(name: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM cursors WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value;
  }

  setCursor(name: string, value: string): void {
    this.db.prepare("INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  // outbox

  putOutbox(row: Omit<OutboxRow, "updated_at">): void {
    this.db
      .prepare(
        `INSERT INTO outbox (idempotency_key, execution_id, kind, payload, status, response, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(row.idempotency_key, row.execution_id, row.kind, JSON.stringify(row.payload), row.status, row.response === undefined ? null : JSON.stringify(row.response), row.created_at, row.created_at);
  }

  updateOutbox(idempotencyKey: string, status: OutboxStatus, response: unknown, at: string): void {
    this.db.prepare("UPDATE outbox SET status = ?, response = ?, updated_at = ? WHERE idempotency_key = ?").run(status, response === undefined ? null : JSON.stringify(response), at, idempotencyKey);
  }

  getOutbox(idempotencyKey: string): OutboxRow | undefined {
    const row = this.db.prepare("SELECT * FROM outbox WHERE idempotency_key = ?").get(idempotencyKey) as (Omit<OutboxRow, "payload" | "response"> & { payload: string; response: string | null }) | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload), response: row.response ? JSON.parse(row.response) : undefined } : undefined;
  }

  listOutbox(filter: { execution_id?: string; status?: OutboxStatus[] } = {}): OutboxRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.execution_id) {
      where.push("execution_id = ?");
      args.push(filter.execution_id);
    }
    if (filter.status) {
      where.push(`status IN (${filter.status.map(() => "?").join(",")})`);
      args.push(...filter.status);
    }
    const sql = `SELECT * FROM outbox ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, idempotency_key`;
    return (this.db.prepare(sql).all(...args) as Array<Omit<OutboxRow, "payload" | "response"> & { payload: string; response: string | null }>).map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
      response: r.response ? JSON.parse(r.response) : undefined,
    }));
  }

  // approvals

  saveApproval(artifact: ApprovalArtifact): void {
    this.db.prepare("INSERT OR REPLACE INTO approvals (approval_id, execution_id, json, created_at) VALUES (?, ?, ?, ?)").run(artifact.approval_id, artifact.execution_id, JSON.stringify(artifact), artifact.approved_at);
  }

  getApproval(approvalId: string): ApprovalArtifact | undefined {
    const row = this.db.prepare("SELECT json FROM approvals WHERE approval_id = ?").get(approvalId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ApprovalArtifact) : undefined;
  }

  // stub rail (sandbox stand-in, persisted so a restart still sees the attempt)

  stubRailGet(attemptId: string): { request: unknown; outcome: unknown; at: string } | undefined {
    const row = this.db.prepare("SELECT request, outcome, at FROM stub_rail_attempts WHERE attempt_id = ?").get(attemptId) as { request: string; outcome: string; at: string } | undefined;
    return row ? { request: JSON.parse(row.request), outcome: JSON.parse(row.outcome), at: row.at } : undefined;
  }

  stubRailFindByReceipt(receiptId: string): { request: unknown; outcome: unknown; at: string } | undefined {
    const row = this.db.prepare("SELECT request, outcome, at FROM stub_rail_attempts WHERE json_extract(outcome, '$.receipt_id') = ?").get(receiptId) as { request: string; outcome: string; at: string } | undefined;
    return row ? { request: JSON.parse(row.request), outcome: JSON.parse(row.outcome), at: row.at } : undefined;
  }

  stubRailFindByTransaction(transactionId: string): { request: unknown; outcome: unknown; at: string } | undefined {
    const row = this.db.prepare("SELECT request, outcome, at FROM stub_rail_attempts WHERE json_extract(outcome, '$.transaction_id') = ?").get(transactionId) as { request: string; outcome: string; at: string } | undefined;
    return row ? { request: JSON.parse(row.request), outcome: JSON.parse(row.outcome), at: row.at } : undefined;
  }

  stubRailPut(attemptId: string, request: unknown, outcome: unknown, at: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO stub_rail_attempts (attempt_id, request, outcome, at) VALUES (?, ?, ?, ?)").run(attemptId, JSON.stringify(request), JSON.stringify(outcome), at);
    return result.changes === 1;
  }

  /** The stub receivable rail: an issued charge changes state as its payer acts, under the same attempt id. */
  stubRailReplace(attemptId: string, request: unknown, outcome: unknown, at: string): void {
    this.db
      .prepare("INSERT INTO stub_rail_attempts (attempt_id, request, outcome, at) VALUES (?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET outcome = excluded.outcome, at = excluded.at")
      .run(attemptId, JSON.stringify(request), JSON.stringify(outcome), at);
  }

  // stub mandate status / org pause (the local stand-in of stubs/mandate-status.ts, for runs without a key)

  stubMandateStatus(mandateId: string): { status: string; reason: string | null } | undefined {
    return this.db.prepare("SELECT status, reason FROM stub_mandate_status WHERE mandate_id = ?").get(mandateId) as { status: string; reason: string | null } | undefined;
  }

  stubSetMandateStatus(mandateId: string, status: string, reason: string | null, at: string): void {
    this.db
      .prepare("INSERT INTO stub_mandate_status (mandate_id, status, reason, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(mandate_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, updated_at = excluded.updated_at")
      .run(mandateId, status, reason, at);
  }

  stubOrgPaused(orgId: string): boolean {
    const row = this.db.prepare("SELECT paused FROM stub_org WHERE org_id = ?").get(orgId) as { paused: number } | undefined;
    return row?.paused === 1;
  }

  stubSetOrgPaused(orgId: string, paused: boolean, at: string): void {
    this.db.prepare("INSERT INTO stub_org (org_id, paused, updated_at) VALUES (?, ?, ?) ON CONFLICT(org_id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at").run(orgId, paused ? 1 : 0, at);
  }
}
