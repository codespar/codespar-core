import { describe, expect, it } from "vitest";
import type { ExecutionItem } from "@codespar/agent-core";
import { AGREEMENTS } from "../src/agreements.js";
import { checkEnvelope, floorMinor, type Envelope } from "../src/envelope.js";

const envelope: Envelope = { max_discount_pct: 15, max_instalments: 3, due_date_window_days: 90, min_instalment_minor: 5000, collection_hours: "08:00-20:00" };
const NOW = new Date("2026-09-23T18:00:00Z"); // 15:00 in Sao Paulo
const TZ = "America/Sao_Paulo";
const joana = AGREEMENTS[0]!;

function items(list: Array<{ amount: number; due_date?: string; payee?: string }>): Pick<{ items: ExecutionItem[]; total: number }, "items" | "total"> {
  const out = list.map((i) => ({ beneficiary: "x", payee: i.payee ?? joana.document, amount: i.amount, currency: "BRL", ...(i.due_date ? { due_date: i.due_date } : {}) }));
  return { items: out, total: out.reduce((s, i) => s + i.amount, 0) };
}

describe("the negotiation envelope is deterministic code", () => {
  it("the floor is the principal minus the maximum discount, rounded up", () => {
    expect(floorMinor(joana, envelope)).toBe(102000);
    expect(floorMinor({ ...joana, principal_minor: 100001 }, envelope)).toBe(85001);
  });

  it("inside: in full with the maximum discount, or three instalments inside the window", () => {
    expect(checkEnvelope(items([{ amount: 102000, due_date: "2026-09-30" }]), envelope, NOW, TZ)).toBeUndefined();
    expect(checkEnvelope(items([{ amount: 40000, due_date: "2026-09-30" }, { amount: 40000, due_date: "2026-10-30" }, { amount: 40000, due_date: "2026-11-30" }]), envelope, NOW, TZ)).toBeUndefined();
  });

  it("outside: discount above the ceiling, more than the principal, too many instalments, a tiny instalment", () => {
    expect(checkEnvelope(items([{ amount: 101999, due_date: "2026-09-30" }]), envelope, NOW, TZ)?.reason).toBe("outside_envelope");
    expect(checkEnvelope(items([{ amount: 120001, due_date: "2026-09-30" }]), envelope, NOW, TZ)?.detail).toContain("acima do principal");
    expect(checkEnvelope(items([{ amount: 30000, due_date: "2026-09-30" }, { amount: 30000, due_date: "2026-10-30" }, { amount: 30000, due_date: "2026-11-30" }, { amount: 30000, due_date: "2026-12-15" }]), envelope, NOW, TZ)?.detail).toContain("parcelas");
    expect(checkEnvelope(items([{ amount: 118000, due_date: "2026-09-30" }, { amount: 2000, due_date: "2026-10-30" }]), envelope, NOW, TZ)?.detail).toContain("minimo");
  });

  it("due dates: in the past, beyond the window, out of order, missing", () => {
    expect(checkEnvelope(items([{ amount: 120000, due_date: "2026-09-22" }]), envelope, NOW, TZ)?.detail).toContain("ja passou");
    expect(checkEnvelope(items([{ amount: 120000, due_date: "2026-12-23" }]), envelope, NOW, TZ)?.detail).toContain("fora da janela");
    expect(checkEnvelope(items([{ amount: 120000, due_date: "2026-12-22" }]), envelope, NOW, TZ)).toBeUndefined();
    expect(checkEnvelope(items([{ amount: 60000, due_date: "2026-10-30" }, { amount: 60000, due_date: "2026-09-30" }]), envelope, NOW, TZ)?.detail).toContain("antes da anterior");
    expect(checkEnvelope(items([{ amount: 120000 }]), envelope, NOW, TZ)?.detail).toContain("sem vencimento");
  });

  it("collection hours are refused in both modes, whatever the proposal", () => {
    const night = new Date("2026-09-24T01:00:00Z"); // 22:00 in Sao Paulo
    const verdict = checkEnvelope(items([{ amount: 120000, due_date: "2026-09-30" }]), envelope, night, TZ);
    expect(verdict?.reason).toBe("outside_hours");
    const morning = new Date("2026-09-24T11:00:00Z"); // 08:00 in Sao Paulo, the window opens
    expect(checkEnvelope(items([{ amount: 120000, due_date: "2026-09-30" }]), envelope, morning, TZ)).toBeUndefined();
  });

  it("one execution, one agreement", () => {
    expect(checkEnvelope(items([{ amount: 60000, due_date: "2026-09-30" }, { amount: 60000, due_date: "2026-10-30", payee: AGREEMENTS[1]!.document }]), envelope, NOW, TZ)?.detail).toContain("more than one debtor");
  });
});
