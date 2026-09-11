import { readFile } from "node:fs/promises";
import { CliError } from "../config.js";

/**
 * Resolve a meta-tool command's args from `--input '<json>'` or
 * `--input-file <path>`. Shared by the `ledger` / `issue` commands (and
 * a good target for charge/ship to migrate onto). Returns a parsed JSON
 * object or throws a CliError with an actionable message.
 */
export async function resolveMetaInput(
  opts: { input?: string; inputFile?: string },
  name: string,
  example: string,
): Promise<Record<string, unknown>> {
  if (opts.input && opts.inputFile) {
    throw new CliError("Pass either --input or --input-file, not both.");
  }
  if (!opts.input && !opts.inputFile) {
    throw new CliError(
      `${name} requires --input '<json>' or --input-file <path>. Example: --input '${example}'`,
    );
  }
  const raw = opts.inputFile
    ? await readFile(opts.inputFile, "utf-8")
    : (opts.input as string);
  const source = opts.inputFile ?? "--input";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CliError(`${source} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Same two flags, but the body is optional: a GET has nothing to send and
 * a POST may take an empty body. Returns `undefined` when neither flag is
 * given, and throws the same way as `resolveMetaInput` when one is given
 * and does not parse.
 */
export async function resolveOptionalInput(
  opts: { input?: string; inputFile?: string },
  what: string,
): Promise<Record<string, unknown> | undefined> {
  if (opts.input === undefined && opts.inputFile === undefined) return undefined;
  return resolveMetaInput(opts, what, "{}");
}
