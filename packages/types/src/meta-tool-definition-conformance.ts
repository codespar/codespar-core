/* ── Definition conformance: schema, enums, and embedded shapes ──
 *
 * The checks that keep a published SharedMetaToolDefinition honest, and the
 * comparator a runtime's conformance test uses to hold its agent-facing
 * tools to the shared contract.
 *
 * Why prose is in scope now (ent#933): the previous conformance check
 * compared only property names, per-property type, and the required set —
 * "structural, not prose" — while the actual vocabularies (which rails
 * codespar_pay takes, which actions a tool accepts) lived ONLY in
 * description prose. The check stayed green across a triple drift: the
 * published contract advertised rails with no route (sepa, usdc), missed
 * capabilities the runtime had (recipient-as-object), and covered 3 of 15
 * tools. The fix is two-sided: vocabularies move into structured `enum`
 * arrays where a test can see them (meta-tool-definitions.ts), and the
 * checks below assert BOTH the structured schema AND the enums/embedded
 * shapes — including that prose and schema agree, so a vocabulary can no
 * longer drift in a description string alone.
 * ─────────────────────────────────────────────────────────────── */

import type {
  MetaToolInputProperty,
  SharedMetaToolDefinition,
} from "./meta-tool-definitions.js";

/** A single definition-level violation: which check failed and why. */
export interface DefinitionViolation {
  code: "contract-drift" | "enum-shape" | "enum-prose" | "ghost-rail";
  detail: string;
}

/**
 * Rails that route NOWHERE on any tool: retired from the published surface
 * (ent#932 — sepa never had a catalog row; ted is unpublished until the
 * public TED route ships). They must not appear, as a word, in ANY prose a
 * definition publishes. Adding a rail back means deleting it from this list
 * in the same change that ships the route — the two cannot drift apart.
 */
export const RETIRED_RAIL_TOKENS = ["sepa", "ted"] as const;

/**
 * "usdc" IS routable — via codespar_crypto_pay. Published prose may name it
 * only (a) in a definition that declares it in a structured `enum` (the
 * crypto tool owns the rail), or (b) inside a sentence that names the
 * redirect target, so an agent reading the prose is pointed at the tool
 * that actually routes it.
 */
const REDIRECTED_RAIL_TOKEN = "usdc";
const REDIRECT_TARGET_TOOL = "codespar_crypto_pay";

/** The minimal agent-facing tool shape a runtime exposes for comparison. */
export interface AgentFacingToolShape {
  name: string;
  description?: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
}

/** Every prose surface a definition publishes: [where, text] pairs. */
export function proseSurfaces(def: {
  name: string;
  description?: string;
  input_schema: { properties: Record<string, unknown> };
}): Array<[string, string]> {
  const surfaces: Array<[string, string]> = [
    ["tool description", String(def.description ?? "")],
  ];
  const walk = (props: Record<string, unknown>, prefix: string): void => {
    for (const [name, raw] of Object.entries(props)) {
      const prop = raw as MetaToolInputProperty | undefined;
      if (!prop || typeof prop !== "object") continue;
      surfaces.push([
        `property "${prefix}${name}" description`,
        String(prop.description ?? ""),
      ]);
      if (prop.properties) walk(prop.properties, `${prefix}${name}.`);
    }
  };
  walk(def.input_schema.properties, "");
  return surfaces;
}

/** All structured enum declarations in a schema, keyed by property path. */
function enumsByPath(
  props: Record<string, MetaToolInputProperty>,
  prefix = "",
): Map<string, { values: readonly string[]; description: string }> {
  const out = new Map<string, { values: readonly string[]; description: string }>();
  for (const [name, prop] of Object.entries(props)) {
    if (prop.enum) {
      out.set(`${prefix}${name}`, {
        values: prop.enum,
        description: String(prop.description ?? ""),
      });
    }
    if (prop.properties) {
      for (const [path, v] of enumsByPath(prop.properties, `${prefix}${name}.`)) {
        out.set(path, v);
      }
    }
  }
  return out;
}

/** True when any structured enum in the definition carries `token`. */
function definitionOwnsToken(def: SharedMetaToolDefinition, token: string): boolean {
  for (const [, { values }] of enumsByPath(def.input_schema.properties)) {
    if (values.some((v) => v.toLowerCase() === token)) return true;
  }
  return false;
}

function wordRegex(token: string): RegExp {
  return new RegExp(`\\b${token}\\b`, "i");
}

/**
 * Sweep one prose surface for ghost rails. `ownsRedirectedToken` marks a
 * definition that publishes the redirected token in a structured enum (the
 * tool that owns the rail), which exempts its prose.
 */
function ghostRailViolations(
  toolName: string,
  where: string,
  text: string,
  ownsRedirectedToken: boolean,
): DefinitionViolation[] {
  const violations: DefinitionViolation[] = [];
  for (const token of RETIRED_RAIL_TOKENS) {
    if (wordRegex(token).test(text)) {
      violations.push({
        code: "ghost-rail",
        detail: `${toolName}: "${token}" advertised in the ${where} but routes nowhere`,
      });
    }
  }
  if (!ownsRedirectedToken) {
    for (const sentence of text.split(/(?<=\.)\s+/)) {
      if (wordRegex(REDIRECTED_RAIL_TOKEN).test(sentence) && !sentence.includes(REDIRECT_TARGET_TOOL)) {
        violations.push({
          code: "ghost-rail",
          detail: `${toolName}: "${REDIRECTED_RAIL_TOKEN}" appears in the ${where} outside a ${REDIRECT_TARGET_TOOL} redirect`,
        });
      }
    }
  }
  return violations;
}

/**
 * Verify a published definition's internal integrity: the derived contract
 * matches the schema (properties, required, enums), every declared enum is
 * well-formed, every enum value is visible in the property's prose, and no
 * prose surface advertises a ghost rail.
 *
 * Returns the violations found (empty array = the definition is coherent).
 */
export function definitionViolations(def: SharedMetaToolDefinition): DefinitionViolation[] {
  const violations: DefinitionViolation[] = [];

  // 1. Contract ↔ schema drift (top-level surface).
  const schemaProps = Object.keys(def.input_schema.properties).sort();
  const contractProps = [...def.contract.properties].sort();
  if (JSON.stringify(schemaProps) !== JSON.stringify(contractProps)) {
    violations.push({
      code: "contract-drift",
      detail: `${def.name}: contract.properties [${contractProps}] != schema properties [${schemaProps}]`,
    });
  }
  const schemaReq = [...(def.input_schema.required ?? [])].sort();
  const contractReq = [...def.contract.required].sort();
  if (JSON.stringify(schemaReq) !== JSON.stringify(contractReq)) {
    violations.push({
      code: "contract-drift",
      detail: `${def.name}: contract.required [${contractReq}] != schema required [${schemaReq}]`,
    });
  }
  for (const r of def.contract.required) {
    if (!def.contract.properties.includes(r)) {
      violations.push({
        code: "contract-drift",
        detail: `${def.name}: required "${r}" is not an advertised property`,
      });
    }
  }

  // 2. Contract ↔ schema drift (vocabularies). Only TOP-LEVEL enums are
  // mirrored into contract.enums (nested ones stay pinned via the schema
  // itself); a top-level schema enum missing from the contract — or a
  // contract vocabulary no schema property declares — is drift.
  const contractEnums = def.contract.enums ?? {};
  for (const [name, prop] of Object.entries(def.input_schema.properties)) {
    if (prop.enum) {
      const mirrored = contractEnums[name];
      if (!mirrored || JSON.stringify([...mirrored]) !== JSON.stringify([...prop.enum])) {
        violations.push({
          code: "contract-drift",
          detail: `${def.name}: schema enum on "${name}" is not mirrored in contract.enums`,
        });
      }
    }
  }
  for (const name of Object.keys(contractEnums)) {
    if (!def.input_schema.properties[name]?.enum) {
      violations.push({
        code: "contract-drift",
        detail: `${def.name}: contract.enums["${name}"] has no schema enum backing it`,
      });
    }
  }

  // 3. Enum well-formedness + enum ↔ prose agreement (all levels).
  for (const [path, { values, description }] of enumsByPath(def.input_schema.properties)) {
    if (values.length === 0) {
      violations.push({
        code: "enum-shape",
        detail: `${def.name}: enum on "${path}" is empty`,
      });
      continue;
    }
    if (new Set(values.map((v) => v.toLowerCase())).size !== values.length) {
      violations.push({
        code: "enum-shape",
        detail: `${def.name}: enum on "${path}" has duplicate values`,
      });
    }
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) {
        violations.push({
          code: "enum-shape",
          detail: `${def.name}: enum on "${path}" has a non-string or empty value`,
        });
        continue;
      }
      if (!description.toLowerCase().includes(value.toLowerCase())) {
        violations.push({
          code: "enum-prose",
          detail: `${def.name}: enum value "${value}" on "${path}" is invisible in the property description — schema and prose disagree`,
        });
      }
    }
  }

  // 4. Ghost rails in any published prose surface.
  const owns = definitionOwnsToken(def, REDIRECTED_RAIL_TOKEN);
  for (const [where, text] of proseSurfaces(def)) {
    violations.push(...ghostRailViolations(def.name, where, text, owns));
  }

  return violations;
}

/**
 * Compare a runtime's agent-facing tool against a shared definition — the
 * cross-runtime half of the conformance surface. Extends the historical
 * structural check (name, property presence, per-property type, required
 * set, allowlisted extras) with the ent#933 hardening:
 *
 * - a shared structured enum must be honored: when the runtime property
 *   declares its own enum it must contain every shared value (a runtime may
 *   EXTEND a vocabulary the way it may add allowlisted properties — it may
 *   never shrink one), and the runtime property's prose must mention every
 *   shared value (a vocabulary item cannot be silently hidden);
 * - a shared embedded shape (nested `properties`) must be present with
 *   matching per-property types;
 * - no runtime prose surface may advertise a retired rail.
 *
 * `allowedExtras` names the ONLY properties the runtime may publish beyond
 * the shared contract — every entry is a claim that the runtime-side
 * mechanism exists.
 */
export function sharedDefinitionConformanceReasons(
  tool: AgentFacingToolShape,
  shared: SharedMetaToolDefinition,
  allowedExtras: ReadonlySet<string> = new Set(),
): string[] {
  const reasons: string[] = [];
  if (tool.name !== shared.name) {
    reasons.push(`name "${tool.name}" != "${shared.name}"`);
  }

  const toolProps = new Set(Object.keys(tool.input_schema.properties));
  const sharedProps = [...shared.contract.properties].sort();
  const missing = sharedProps.filter((p) => !toolProps.has(p));
  if (missing.length > 0) {
    reasons.push(`missing shared properties [${missing}]`);
  }
  const sharedSet = new Set(sharedProps);
  const unexpected = [...toolProps]
    .filter((p) => !sharedSet.has(p) && !allowedExtras.has(p))
    .sort();
  if (unexpected.length > 0) {
    reasons.push(`unexpected extra properties [${unexpected}] (not allowlisted)`);
  }

  const asProp = (p: unknown): MetaToolInputProperty | undefined =>
    p && typeof p === "object" ? (p as MetaToolInputProperty) : undefined;

  for (const k of sharedProps) {
    const toolProp = asProp(tool.input_schema.properties[k]);
    const sharedProp = shared.input_schema.properties[k];
    if (!toolProp || !sharedProp) continue; // presence already reported
    if (toolProp.type !== sharedProp.type) {
      reasons.push(
        `property "${k}" type ${JSON.stringify(toolProp.type)} != ${JSON.stringify(sharedProp.type)}`,
      );
    }
    // Shared vocabulary must be honored — structurally when the runtime
    // declares one, and in the agent-visible prose always.
    if (sharedProp.enum) {
      if (toolProp.enum) {
        const toolValues = new Set(toolProp.enum.map((v) => String(v).toLowerCase()));
        const dropped = sharedProp.enum.filter((v) => !toolValues.has(v.toLowerCase()));
        if (dropped.length > 0) {
          reasons.push(`property "${k}" enum drops shared values [${dropped}]`);
        }
      }
      const prose = String(toolProp.description ?? "").toLowerCase();
      for (const value of sharedProp.enum) {
        if (!prose.includes(value.toLowerCase())) {
          reasons.push(
            `property "${k}" prose hides the shared vocabulary value "${value}"`,
          );
        }
      }
    }
    // Shared embedded shape must be present with matching types.
    if (sharedProp.properties) {
      const nested = toolProp.properties ?? {};
      for (const [name, sharedNested] of Object.entries(sharedProp.properties)) {
        const toolNested = asProp(nested[name]);
        if (!toolNested) {
          reasons.push(`property "${k}" is missing the embedded property "${name}"`);
        } else if (toolNested.type !== sharedNested.type) {
          reasons.push(
            `embedded property "${k}.${name}" type ${JSON.stringify(toolNested.type)} != ${JSON.stringify(sharedNested.type)}`,
          );
        }
      }
    }
  }

  const toolReq = [...(tool.input_schema.required ?? [])].sort();
  const sharedReq = [...shared.contract.required].sort();
  if (JSON.stringify(toolReq) !== JSON.stringify(sharedReq)) {
    reasons.push(`required [${toolReq}] != [${sharedReq}]`);
  }

  // Retired rails must not be advertised in the runtime's prose either —
  // this is the sweep that would have flagged the pre-#932 TED
  // advertisement living in the runtime's `recipient` description while the
  // published contract knew nothing about it.
  for (const [where, text] of proseSurfaces(tool)) {
    for (const token of RETIRED_RAIL_TOKENS) {
      if (wordRegex(token).test(text)) {
        reasons.push(`"${token}" advertised in the runtime ${where} but routes nowhere`);
      }
    }
  }

  return reasons;
}
