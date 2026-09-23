import { randomBytes } from "node:crypto";

export function newId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function newRunId(label?: string): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return label ? `run_${stamp}_${label}_${randomBytes(3).toString("hex")}` : `run_${stamp}_${randomBytes(3).toString("hex")}`;
}
