/**
 * The converter measured against a real JSON Schema validator.
 *
 * For every schema in the corpus, candidate tool inputs are generated from
 * the schema and each is judged by ajv and by the converted Zod schema. The
 * contract:
 *
 *   - the converter never throws;
 *   - Zod never rejects an input ajv accepts;
 *   - Zod accepts an input ajv rejects only when ajv, with every advisory
 *     and marked keyword removed, accepts it too — the extra leniency is
 *     exactly the keywords the converter declares it does not enforce.
 *
 * Tool inputs are objects, so only object candidates are judged at the root.
 * Set DIFF_REPORT=<path> to write the per-schema scoreboard.
 */

import { describe, it, expect, afterAll } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as types from "@codespar/types";
import { jsonSchemaToZod } from "../schema.js";
import { KEYWORD_SUPPORT } from "../keywords.js";
import { rootInputs } from "./support/generate.js";
import { judge, keywordsIn, withoutLenient } from "./support/oracle.js";

type Json = Record<string, unknown>;
interface Case {
  corpus: "meta-tools" | "fixtures" | "mcp";
  name: string;
  schema: Json;
}

const here = dirname(fileURLToPath(import.meta.url));

function corpus(): Case[] {
  const cases: Case[] = [];
  for (const [key, value] of Object.entries(types)) {
    if (!key.endsWith("_DEFINITION")) continue;
    const def = value as { name?: string; input_schema?: Json };
    if (def?.input_schema) cases.push({ corpus: "meta-tools", name: def.name ?? key, schema: def.input_schema });
  }
  const fx = join(here, "fixtures/schemas");
  for (const f of readdirSync(fx).sort()) {
    cases.push({ corpus: "fixtures", name: f.replace(/\.json$/, ""), schema: JSON.parse(readFileSync(join(fx, f), "utf8")) });
  }
  const mcp = join(here, "fixtures/mcp");
  for (const f of readdirSync(mcp).sort()) {
    const server = JSON.parse(readFileSync(join(mcp, f), "utf8")) as { tools: { name: string; input_schema: Json }[] };
    for (const t of server.tools) cases.push({ corpus: "mcp", name: `${f.replace(/\.json$/, "")}/${t.name}`, schema: t.input_schema });
  }
  return cases;
}

interface Result {
  corpus: string;
  name: string;
  inputs: number;
  skipped?: string;
  threw?: string;
  rejectsValid: unknown[];
  acceptsInvalidUnmarked: unknown[];
  acceptsInvalidMarked: number;
  lenientKeywords: string[];
}

function run(c: Case): Result {
  const result: Result = {
    corpus: c.corpus,
    name: c.name,
    inputs: 0,
    rejectsValid: [],
    acceptsInvalidUnmarked: [],
    acceptsInvalidMarked: 0,
    lenientKeywords: [...keywordsIn(c.schema)].filter((k) => KEYWORD_SUPPORT[k] === "advisory" || KEYWORD_SUPPORT[k] === "marked").filter((k) => k !== "description"),
  };
  const strict = judge(c.schema);
  if (typeof strict !== "function") return { ...result, skipped: strict.skipped };
  const lenient = judge(withoutLenient(c.schema) as Json);
  if (typeof lenient !== "function") return { ...result, skipped: `lenient: ${lenient.skipped}` };
  let zod: ReturnType<typeof jsonSchemaToZod>;
  try {
    zod = jsonSchemaToZod(c.schema);
  } catch (err) {
    return { ...result, threw: `convert: ${String(err).slice(0, 120)}` };
  }
  const inputs = rootInputs(c.schema);
  result.inputs = inputs.length;
  for (const x of inputs) {
    let z: boolean;
    try {
      z = zod.safeParse(x).success;
    } catch (err) {
      return { ...result, threw: `parse: ${String(err).slice(0, 120)}` };
    }
    const a = strict(x);
    if (a && !z) result.rejectsValid.push(x);
    else if (!a && z) {
      if (lenient(x)) result.acceptsInvalidMarked++;
      else result.acceptsInvalidUnmarked.push(x);
    }
  }
  return result;
}

const cases = corpus();
const results: Result[] = [];

afterAll(() => {
  const path = process.env.DIFF_REPORT;
  if (path) writeFileSync(path, JSON.stringify(results, null, 2));
});

describe.each(["meta-tools", "fixtures", "mcp"] as const)("differential against ajv: %s", (name) => {
  const group = cases.filter((c) => c.corpus === name);

  it("has a corpus", () => {
    expect(group.length).toBeGreaterThan(name === "fixtures" ? 40 : name === "mcp" ? 50 : 10);
  });

  it.each(group.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const r = run(c);
    results.push(r);
    if (r.skipped) {
      // Only the fixtures written for that purpose may be beyond the oracle.
      expect(c.name, r.skipped).toMatch(/^oracle-skip-/);
      return;
    }
    expect(r.threw, r.threw).toBeUndefined();
    expect(r.rejectsValid, `rejects input ajv accepts: ${JSON.stringify(r.rejectsValid.slice(0, 3))}`).toEqual([]);
    expect(
      r.acceptsInvalidUnmarked,
      `accepts input ajv rejects, not explained by a marked/advisory keyword: ${JSON.stringify(r.acceptsInvalidUnmarked.slice(0, 3))}`,
    ).toEqual([]);
    expect(r.inputs).toBeGreaterThan(0);
  });
});
