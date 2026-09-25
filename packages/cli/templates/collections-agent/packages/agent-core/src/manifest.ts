/**
 * Section 4.3: the `agent.yaml` manifest, `schema: 1`.
 *
 * The schema promises stability from now on: a field is removed or changes
 * meaning only under a new `schema` number.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const PINNED_PACKAGE = /^@codespar\/(mcp|cli)@\d+\.\d+\.\d+$/;
const HOURS_WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export const MaturitySchema = z.enum(["live", "sandbox", "blocked"]);

export const EscalateAboveSchema = z
  .object({
    /** Minor units. A payment above this, still inside the mandate cap, asks a human. */
    amount: z.number().int().positive().optional(),
    /** The first payment to a payee that is already on the allowlist asks a human. */
    new_beneficiary: z.boolean().optional(),
    /** "HH:MM-HH:MM", may cross midnight. Execution requested inside it asks a human. */
    outside_hours: z.string().regex(HOURS_WINDOW, 'expected "HH:MM-HH:MM"').optional(),
  })
  .strict();

export const ManifestSchema = z
  .object({
    schema: z.literal(1),
    name: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    approval: z.array(z.enum(["human", "mandate"])).nonempty(),
    default_approval: z.enum(["human", "mandate"]),
    escalate_above: EscalateAboveSchema.optional(),
    mcp: z.string().regex(PINNED_PACKAGE, "mcp must pin an exact version, e.g. @codespar/mcp@0.5.8"),
    cli: z.string().regex(PINNED_PACKAGE, "cli must pin an exact version, e.g. @codespar/cli@0.14.0"),
    tools: z.string(),
    guardrails: z.string(),
    mandate_schema: z.string(),
    events: z.array(z.string().regex(/^commerce\.[a-z_.]+$/)),
    channels: z.array(z.enum(["terminal", "whatsapp"])).nonempty(),
    maturity: z.record(z.string(), MaturitySchema),
    scenarios: z.string(),
    evals: z.string(),
    agents_md: z.string(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (!m.approval.includes(m.default_approval)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["default_approval"], message: "default_approval must be one of approval" });
    }
  });

export type Manifest = z.infer<typeof ManifestSchema>;
export type EscalateAbove = z.infer<typeof EscalateAboveSchema>;

export interface LoadedManifest {
  manifest: Manifest;
  /** Absolute path of the manifest file. */
  path: string;
  /** Directory the relative paths in the manifest resolve against. */
  dir: string;
  resolvePath(relative: string): string;
}

export function parseManifest(text: string): Manifest {
  return ManifestSchema.parse(parseYaml(text));
}

export function loadManifest(path: string): LoadedManifest {
  const absolute = resolve(path);
  const manifest = parseManifest(readFileSync(absolute, "utf8"));
  const dir = dirname(absolute);
  return { manifest, path: absolute, dir, resolvePath: (relative) => resolve(dir, relative) };
}
