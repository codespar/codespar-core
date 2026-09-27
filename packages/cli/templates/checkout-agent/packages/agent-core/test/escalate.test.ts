import { describe, expect, it } from "vitest";
import { evaluateEscalation, isOutsideHours, localClock } from "../src/escalate.js";
import { GuardrailsSchema } from "../src/guardrails.js";
import type { ExecutionItem } from "../src/types.js";

const rule = { amount: 150000, new_beneficiary: true, outside_hours: "22:00-07:00" };
const guardrails = GuardrailsSchema.parse({ approval: "mandate", escalate_above: rule, velocity: { window_hours: 24 } });
const item = (payee: string, amount: number): ExecutionItem => ({ beneficiary: payee, payee, amount, currency: "BRL" });
// 15:00 in Sao Paulo (UTC-3) is 18:00Z.
const afternoon = new Date("2026-09-23T18:00:00Z");
const ctx = (over: Partial<Parameters<typeof evaluateEscalation>[3]> = {}) => ({ now: afternoon, timezone: "America/Sao_Paulo", knownPayees: new Set(["escola@x"]), recentByPayee: new Map(), ...over });

describe("section 4.4: escalate_above only tightens", () => {
  it("amount above the threshold escalates, below it does not", () => {
    expect(evaluateEscalation(rule, guardrails, [item("escola@x", 150001)], ctx())?.trigger).toBe("amount");
    expect(evaluateEscalation(rule, guardrails, [item("escola@x", 150000)], ctx())).toBeUndefined();
  });

  it("fractioning: parts below the threshold add up inside the velocity window", () => {
    const recent = new Map([["escola@x", 120000]]);
    const out = evaluateEscalation(rule, guardrails, [item("escola@x", 40000)], ctx({ recentByPayee: recent }));
    expect(out?.trigger).toBe("amount");
    expect(out?.detail).toContain("add up");
  });

  it("first payment to a payee escalates; the second does not", () => {
    expect(evaluateEscalation(rule, guardrails, [item("mercado@x", 1000)], ctx())?.trigger).toBe("new_beneficiary");
    expect(evaluateEscalation(rule, guardrails, [item("escola@x", 1000)], ctx())).toBeUndefined();
  });

  it("outside hours escalates, and the window crosses midnight", () => {
    const night = new Date("2026-09-24T02:00:00Z"); // 23:00 in Sao Paulo
    expect(localClock(night, "America/Sao_Paulo")).toBe("23:00");
    expect(isOutsideHours("22:00-07:00", night, "America/Sao_Paulo")).toBe(true);
    expect(isOutsideHours("22:00-07:00", afternoon, "America/Sao_Paulo")).toBe(false);
    expect(evaluateEscalation(rule, guardrails, [item("escola@x", 1000)], ctx({ now: night }))?.trigger).toBe("outside_hours");
  });

  it("no rule, no escalation", () => {
    expect(evaluateEscalation(undefined, guardrails, [item("x", 10_000_000)], ctx())).toBeUndefined();
  });
});
