/**
 * `guardrails.json`: what the agent applies on its own, before the mandate.
 * Everything here can only tighten the mandate; nothing here widens it.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { EscalateAboveSchema } from "./manifest.js";

export const GuardrailsSchema = z
  .object({
    approval: z.enum(["human", "mandate"]),
    /** Must equal the manifest's `escalate_above`; `npm run check` compares them. */
    escalate_above: EscalateAboveSchema.optional(),
    /** Section 9, fractioning: the window over which amounts to one payee add up towards `escalate_above.amount`. */
    velocity: z
      .object({
        window_hours: z.number().int().positive(),
        /** Optional hard ceiling on the number of executions to one payee in the window. */
        max_per_payee: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** When an `outside_hours` trigger fires: ask a human now, or refuse and let the person retry inside the window. */
    outside_hours_action: z.enum(["escalate", "refuse"]).default("escalate"),
    /** When the model's stated total differs from the core's: execute the core's number, or refuse. Never the model's. */
    model_total_mismatch: z.enum(["use_core", "refuse"]).default("use_core"),
    /** Minutes an approval artifact stays valid. */
    approval_ttl_minutes: z.number().int().positive().default(15),
    /** IANA zone the `outside_hours` window is read in. */
    timezone: z.string().default("America/Sao_Paulo"),
    /**
     * The agent-specific envelope the kit's own deterministic policy reads
     * (a collections agent: discount ceiling, instalments, due-date window).
     * The core carries it and runs the kit's `policyExtension` at every gate;
     * it does not interpret the keys.
     */
    envelope: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type Guardrails = z.infer<typeof GuardrailsSchema>;

export function loadGuardrails(path: string): Guardrails {
  return GuardrailsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
