import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ExecutionItem } from "./types.js";

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

export function hmacSha256Hex(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}

export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
