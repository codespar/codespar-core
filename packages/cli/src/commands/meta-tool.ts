import { CodeSpar } from "@codespar/sdk";
import type { SharedMetaToolDefinition } from "@codespar/sdk";
import { CliError } from "../config.js";
import { c, info, json, kv, renderResult, table } from "../output.js";
import { resolveOptionalInput } from "./meta-input.js";
import { metaToolActions, metaToolDefinition, metaToolNames, META_TOOLS } from "../surface.js";

export interface MetaToolCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  user?: string;
  action?: string;
  arg: string[];
  input?: string;
  inputFile?: string;
  json?: boolean;
}

/**
 * Resolve a tool name against the published definitions. The list in the
 * error is the published list — the CLI knows of no other tool, and a
 * name it cannot find is a name `@codespar/types` does not publish.
 */
export function requireDefinition(name: string): SharedMetaToolDefinition {
  const definition = metaToolDefinition(name);
  if (definition) return definition;
  throw new CliError(
    `Unknown meta-tool "${name}". Published tools:\n  ${metaToolNames().join("\n  ")}`,
  );
}

/**
 * Coerce a `--arg key=value` pair against the property's published type.
 * An `object` or `array` property takes JSON; everything else takes the
 * literal, so a Pix key that looks like a number stays a string when the
 * contract says string.
 */
export function coerceArg(
  definition: SharedMetaToolDefinition,
  key: string,
  raw: string,
): unknown {
  const property = definition.input_schema.properties[key];
  if (!property) {
    throw new CliError(
      `${definition.name} has no property "${key}". Published properties:\n  ${definition.contract.properties.join("\n  ")}`,
    );
  }
  let value: unknown = raw;
  if (property.type === "number" || property.type === "integer") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`${key} expects a number, got "${raw}".`);
    value = n;
  } else if (property.type === "boolean") {
    if (raw !== "true" && raw !== "false") {
      throw new CliError(`${key} expects true or false, got "${raw}".`);
    }
    value = raw === "true";
  } else if (property.type === "object" || property.type === "array") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch (err) {
      throw new CliError(
        `${key} is a ${property.type}; --arg needs valid JSON for it (or use --input): ${(err as Error).message}`,
      );
    }
  }
  if (property.enum && typeof value === "string" && !property.enum.includes(value)) {
    throw new CliError(
      `${key}="${value}" is outside the published vocabulary: ${property.enum.join(" | ")}`,
    );
  }
  return value;
}

/**
 * Build the tool arguments from `--input`, `--arg` and `--action`, then
 * check them against the published contract before anything is sent. The
 * checks are the contract's own: the property names it publishes, the
 * subset it marks required, and the closed vocabularies it declares. No
 * vocabulary is written here — a rail or an action added to the published
 * definition is accepted by this CLI without a code change.
 */
export function buildArgs(
  definition: SharedMetaToolDefinition,
  base: Record<string, unknown> | undefined,
  argPairs: readonly string[],
  action: string | undefined,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(base ?? {}) };

  for (const pair of argPairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new CliError(`--arg expects key=value, got "${pair}".`);
    const key = pair.slice(0, eq);
    args[key] = coerceArg(definition, key, pair.slice(eq + 1));
  }

  if (action !== undefined) {
    const actions = metaToolActions(definition.name);
    if (actions.length === 0) {
      const discriminator = definition.contract.required[0];
      throw new CliError(
        `${definition.name} publishes no "action" property, so --action means nothing to it.` +
          (discriminator
            ? ` Its required input is: ${definition.contract.required.join(", ")} — pass it with --arg ${discriminator}=<value> or --input.`
            : ""),
      );
    }
    if (!actions.includes(action)) {
      throw new CliError(
        `${definition.name} --action "${action}" is outside the published vocabulary: ${actions.join(" | ")}`,
      );
    }
    args.action = action;
  }

  const missing = definition.contract.required.filter(
    (name) => args[name] === undefined || args[name] === "",
  );
  if (missing.length > 0) {
    const how = missing.map((m) => {
      const vocabulary = definition.contract.enums?.[m];
      if (m === "action" && vocabulary) return `--action <${vocabulary.join("|")}>`;
      if (vocabulary) return `--arg ${m}=<${vocabulary.join("|")}>`;
      return `--arg ${m}=<value>`;
    });
    throw new CliError(
      `${definition.name} requires ${missing.join(", ")}. Pass ${how.join(" ")} or --input '<json>'. Nothing was sent.`,
    );
  }

  return args;
}

/**
 * Invoke one of the published meta-tools through a throwaway session, the
 * same wire `session.execute(name, args)` uses. The router picks the rail,
 * so there is no `--server`.
 */
export async function metaToolCommand(
  name: string,
  opts: MetaToolCommandOptions,
): Promise<void> {
  const definition = requireDefinition(name);
  const base = await resolveOptionalInput(opts, definition.name);
  const args = buildArgs(definition, base, opts.arg, opts.action);

  const cs = new CodeSpar({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    projectId: opts.project,
  });
  const session = await cs.create(opts.user ?? "cli-user", { servers: [] });

  try {
    const result = await session.execute(definition.name, args);
    if (!result.success) {
      throw new CliError(`${definition.name} failed: ${result.error ?? "unknown error"}`);
    }
    if (opts.json) {
      json(result.data ?? null);
      return;
    }
    info(`${definition.name}${args.action ? ` action=${String(args.action)}` : ""}`);
    renderResult(result.data);
  } finally {
    await session.close();
  }
}

/** `codespar tools meta` — the published definitions, as published. */
export function listMetaToolsCommand(opts: { json?: boolean }): void {
  if (opts.json) {
    json(META_TOOLS);
    return;
  }
  table(
    ["TOOL", "ACTIONS", "REQUIRED"],
    metaToolNames().map((name) => {
      const definition = META_TOOLS[name]!;
      const actions = metaToolActions(name);
      return [
        name,
        actions.length > 0 ? actions.join(" | ") : "-",
        definition.contract.required.join(", ") || "-",
      ];
    }),
  );
}

/** `codespar tools meta <name>` — one definition, schema and vocabularies. */
export function showMetaToolCommand(name: string, opts: { json?: boolean }): void {
  const definition = requireDefinition(name);
  if (opts.json) {
    json(definition);
    return;
  }
  kv([
    ["Name", definition.name],
    ["Required", definition.contract.required.join(", ") || "-"],
    ["Properties", definition.contract.properties.join(", ")],
  ]);
  process.stdout.write(`\n${definition.description}\n`);
  const enums = definition.contract.enums ?? {};
  if (Object.keys(enums).length > 0) {
    process.stdout.write(`\n${c.bold("Vocabularies")}\n`);
    kv(Object.entries(enums).map(([key, values]) => [key, values.join(" | ")]));
  }
  process.stdout.write("\nInput schema:\n");
  process.stdout.write(JSON.stringify(definition.input_schema, null, 2) + "\n");
}
