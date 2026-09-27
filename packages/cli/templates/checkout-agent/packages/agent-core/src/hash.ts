import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CompositionLine, ExecutionBatch, ExecutionItem } from "./types.js";

/** JSON with keys sorted at every level, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Section 4.2: the hash of the canonical list. Only the fields that decide
 * where money goes take part: payee, amount, currency, and the due date of a
 * receivable when it has one. Aliases, names and descriptions are
 * presentation and may differ without changing the hash.
 */
export function itemsHash(items: readonly ExecutionItem[]): string {
  const canonical = items.map((item) => ({
    payee: item.payee,
    amount: item.amount,
    currency: item.currency,
    ...(item.due_date ? { due_date: item.due_date } : {}),
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

/**
 * The hash of a batch's ordered lines, bound into every artifact of that
 * batch. It IS `itemsHash` over the whole list and deliberately not a second
 * canonicalisation: the same fields decide the set that decide the line, so a
 * reader who concatenates the batch's lines in order and hashes them gets the
 * batch's hash back, and any line moved, re-priced, added or dropped changes
 * it. Order is part of it — `index` names a position, and a position only
 * means something in a list whose order is fixed.
 */
export function batchHash(lines: readonly ExecutionItem[]): string {
  return itemsHash(lines);
}

/**
 * The hash of what an execution's amount is composed of (a cart's resolved
 * lines, in order). The same canonicalisation as `itemsHash` — sorted-key
 * JSON, SHA-256, the `sha256:` prefix — over the fields that decide a
 * composition, and deliberately not `itemsHash` itself: its fields are the
 * ones that decide where money goes (payee, amount, currency, due date), and
 * none of them sees a quantity or a unit price. Ten units at a 10% discount
 * and nine at list price are the same line amount; they are not the same
 * sale. Order is part of it, like a batch.
 */
export function compositionHash(lines: readonly CompositionLine[]): string {
  const canonical = lines.map((line) => ({
    ref: line.ref,
    quantity: line.quantity,
    unit_amount: line.unit_amount,
    amount: line.amount,
    currency: line.currency,
  }));
  return `sha256:${sha256Hex(canonicalJson(canonical))}`;
}

/**
 * The `attempt_id` of an item of a batch line, derived from WHAT is being
 * paid rather than from the execution that happens to pay it:
 *
 *   ska_ + hex(sha256(mandate_id | batch_hash | line index | item index))
 *
 * An execution's own attempt ids come from its `idempotency_key`, which comes
 * from a random execution id, so a second run of the same batch on a machine
 * that has lost `.codespar/state.db` (or never had it) would present fresh ids
 * and the API would take each line as a new payment (OPEN_QUESTIONS §39c).
 * Derived this way, the same line of the same list under the same mandate is
 * the same attempt on any machine, and the API answers a repeat of it from its
 * record of that attempt (ent#1671): the original body when it settled, a 409
 * while it is in flight or pinned, never a second dispatch.
 *
 * Every input decides the payment: the mandate is whose money, the hash is the
 * exact ordered list (payee, amount, currency of every line), the index is
 * which line of it. A list that changes in any line is a different hash and so
 * different ids. `ska_` names the namespace (starter-kit attempt) and 68
 * characters sit inside the API's 128.
 *
 * `generation` exists because the API never runs an attempt id twice: once an
 * attempt FAILED and moved no money, a repeat of it answers
 * `psp_attempt_conflict` for good. A line whose payment the provider refused
 * must still be payable by a later run of the same list, so it moves to the
 * next generation, and only on that answer: the server saying the id is
 * spent is the one fact every machine reads the same way, so every machine
 * walks the same sequence and none of them finds a "free" id past one that
 * paid. Generation 0 hashes exactly as above.
 */
export function batchAttemptId(mandateId: string, batch: Pick<ExecutionBatch, "batch_hash" | "index">, item: number, generation = 0): string {
  const base = `${mandateId}|${batch.batch_hash}|${batch.index}|${item}`;
  return `ska_${sha256Hex(generation === 0 ? base : `${base}|${generation}`)}`;
}

export function hmacSha256Hex(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
