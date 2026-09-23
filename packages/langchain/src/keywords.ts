/**
 * How the converter treats each JSON Schema keyword. One map, three
 * answers, used by the converter itself, by the README's table, and by the
 * differential test's contract:
 *
 *   translated — the Zod schema accepts exactly what the keyword accepts;
 *   advisory   — an annotation: carried in the description, never enforced
 *                (JSON Schema itself treats these as annotations by default);
 *   marked     — not expressed; the field's description says so, and the
 *                Zod schema may accept more than the keyword would, never
 *                less.
 *
 * A keyword outside the map is ignored, as a JSON Schema validator in
 * non-strict mode ignores it.
 */

export type KeywordSupport = "translated" | "advisory" | "marked";

export const KEYWORD_SUPPORT: Readonly<Record<string, KeywordSupport>> = {
  type: "translated",
  properties: "translated",
  required: "translated",
  additionalProperties: "translated",
  items: "translated",
  prefixItems: "translated",
  additionalItems: "translated",
  enum: "translated",
  const: "translated",
  anyOf: "translated",
  oneOf: "translated",
  allOf: "translated",
  $ref: "translated",
  $defs: "translated",
  definitions: "translated",
  nullable: "translated",
  minimum: "translated",
  maximum: "translated",
  exclusiveMinimum: "translated",
  exclusiveMaximum: "translated",
  multipleOf: "translated",
  minLength: "translated",
  maxLength: "translated",
  pattern: "translated",
  minItems: "translated",
  maxItems: "translated",
  uniqueItems: "translated",
  description: "advisory",
  title: "advisory",
  default: "advisory",
  examples: "advisory",
  format: "advisory",
  $schema: "advisory",
  $id: "advisory",
  $anchor: "advisory",
  $comment: "advisory",
  readOnly: "advisory",
  writeOnly: "advisory",
  deprecated: "advisory",
  contentMediaType: "advisory",
  contentEncoding: "advisory",
  not: "marked",
  if: "marked",
  then: "marked",
  else: "marked",
  patternProperties: "marked",
  propertyNames: "marked",
  dependentSchemas: "marked",
  dependentRequired: "marked",
  dependencies: "marked",
  contains: "marked",
  minContains: "marked",
  maxContains: "marked",
  minProperties: "marked",
  maxProperties: "marked",
  unevaluatedProperties: "marked",
  unevaluatedItems: "marked",
  $dynamicRef: "marked",
};

/** Keywords the converter does not express and marks where they appear. */
export const MARKED_KEYWORDS: readonly string[] = Object.entries(KEYWORD_SUPPORT)
  .filter(([, s]) => s === "marked")
  .map(([k]) => k);

/** The README table, rendered from {@link KEYWORD_SUPPORT}. */
export function renderKeywordTable(): string {
  const rows = (["translated", "advisory", "marked"] as const).map((support) => {
    const keys = Object.entries(KEYWORD_SUPPORT)
      .filter(([, s]) => s === support)
      .map(([k]) => `\`${k}\``)
      .join(", ");
    return `| ${support} | ${keys} |`;
  });
  return ["| Support | Keywords |", "|---|---|", ...rows].join("\n");
}
