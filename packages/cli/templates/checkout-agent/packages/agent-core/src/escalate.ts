/**
 * Section 4.4: `escalate_above` only tightens. Each trigger sends a
 * `mandate` execution to `awaiting_approval`; none of them raises a cap or
 * adds a payee. The first trigger that fires is the one the artifact records.
 */
import type { Guardrails } from "./guardrails.js";
import type { EscalateAbove } from "./manifest.js";
import type { EscalationTrigger, ExecutionItem } from "./types.js";

export interface EscalationContext {
  now: Date;
  timezone: string;
  /** Payees this agent has already settled a payment to, under this mandate. */
  knownPayees: ReadonlySet<string>;
  /** Minor units already executed (settled or in flight) per payee inside the velocity window. */
  recentByPayee: ReadonlyMap<string, number>;
}

export interface Escalation {
  trigger: EscalationTrigger;
  detail: string;
}

export function evaluateEscalation(
  rule: EscalateAbove | undefined,
  guardrails: Guardrails,
  items: readonly ExecutionItem[],
  ctx: EscalationContext,
): Escalation | undefined {
  if (!rule) return undefined;

  if (rule.amount !== undefined) {
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    if (total > rule.amount) {
      return { trigger: "amount", detail: `total ${total} is above the escalation threshold ${rule.amount}` };
    }
    // Fractioning (section 9): the same payee, several parts inside the window, adds up.
    if (guardrails.velocity) {
      const perPayee = new Map<string, number>();
      for (const item of items) perPayee.set(item.payee, (perPayee.get(item.payee) ?? 0) + item.amount);
      for (const [payee, amount] of perPayee) {
        const recent = ctx.recentByPayee.get(payee) ?? 0;
        if (recent + amount > rule.amount) {
          return {
            trigger: "amount",
            detail: `payments to ${payee} inside the last ${guardrails.velocity.window_hours}h add up to ${recent + amount}, above the escalation threshold ${rule.amount}`,
          };
        }
      }
    }
  }

  if (rule.new_beneficiary) {
    const fresh = items.find((i) => !ctx.knownPayees.has(i.payee));
    if (fresh) {
      return { trigger: "new_beneficiary", detail: `first payment to ${fresh.beneficiary} (${fresh.payee}) under this mandate` };
    }
  }

  if (rule.outside_hours && isOutsideHours(rule.outside_hours, ctx.now, ctx.timezone)) {
    return { trigger: "outside_hours", detail: `requested at ${localClock(ctx.now, ctx.timezone)}, inside the ${rule.outside_hours} window` };
  }

  return undefined;
}

export function localClock(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

/** `"22:00-07:00"` is the CLOSED window: inside it, the trigger fires. Crosses midnight when start > end. */
export function isOutsideHours(window: string, now: Date, timezone: string): boolean {
  const [start, end] = window.split("-") as [string, string];
  const minutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number) as [number, number];
    return h * 60 + m;
  };
  const current = minutes(localClock(now, timezone));
  const s = minutes(start);
  const e = minutes(end);
  return s <= e ? current >= s && current < e : current >= s || current < e;
}
