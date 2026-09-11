import { CodeSpar } from "@codespar/sdk";
import { CliError } from "../config.js";
import { info, json, renderResult } from "../output.js";
import { resolveOptionalInput } from "./meta-input.js";
import type { DerivedCommand } from "../surface.js";

export interface ResourceCommandOptions {
  apiKey: string;
  baseUrl: string;
  project?: string;
  /** Positional path parameters, in the order the path declares them. */
  args: string[];
  query: string[];
  input?: string;
  inputFile?: string;
  json?: boolean;
  timeout?: string;
}

/**
 * The client's `api` is typed by correlating a literal path with a literal
 * method; a CLI dispatches a pair that is data at runtime, which that
 * correlation cannot express. One cast, at this boundary, to a signature
 * that says what the runtime accepts. Everything the cast hides — that the
 * pair is a real operation, that a path parameter is present — the
 * generated table and `expandPath` check inside the client, and an unknown
 * pair throws there rather than reaching the network.
 */
interface UntypedApi {
  request(
    method: string,
    path: string,
    options?: {
      path?: Record<string, string>;
      query?: Record<string, unknown>;
      body?: unknown;
      timeout?: number;
    },
  ): Promise<unknown>;
}

/** `--query k=v` (repeatable) → `{ k: v }`, repeats collect into an array. */
export function parseQuery(pairs: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`--query expects key=value, got "${pair}".`);
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

/** Positional arguments → the path parameter object the client expands. */
export function bindPathParams(
  command: Pick<DerivedCommand, "params" | "path">,
  args: readonly string[],
): Record<string, string> {
  if (args.length !== command.params.length) {
    throw new CliError(
      `${command.path} takes ${command.params.length} argument(s) (${command.params.join(", ")}), got ${args.length}.`,
    );
  }
  const out: Record<string, string> = {};
  command.params.forEach((name, i) => {
    const value = args[i] ?? "";
    if (value === "") throw new CliError(`Path parameter <${name}> must not be empty.`);
    out[name] = value;
  });
  return out;
}

/**
 * Run one derived resource command: bind the positionals to the path
 * parameters, pass `--query` through, pass `--input` as the request body
 * when the operation declares one, and print whatever came back. No
 * response is synthesised: what prints is the API's own payload, and a
 * non-2xx status surfaces as the API's error.
 */
export async function runResourceCommand(
  command: DerivedCommand,
  opts: ResourceCommandOptions,
): Promise<void> {
  const body = await resolveOptionalInput(opts, `${command.method.toUpperCase()} ${command.path}`);
  if (body !== undefined && !command.acceptsBody) {
    throw new CliError(
      `${command.method.toUpperCase()} ${command.path} declares no request body; drop --input / --input-file.`,
    );
  }

  const timeout = opts.timeout === undefined ? undefined : Number(opts.timeout);
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new CliError(`--timeout expects a positive number of milliseconds, got "${opts.timeout}".`);
  }

  const cs = new CodeSpar({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
    projectId: opts.project,
    ...(timeout !== undefined ? { timeout } : {}),
  });

  const api = cs.api as unknown as UntypedApi;
  const result = await api.request(command.method, command.path, {
    path: bindPathParams(command, opts.args),
    query: parseQuery(opts.query),
    ...(body !== undefined ? { body } : {}),
  });

  if (opts.json) {
    json(result ?? null);
    return;
  }
  info(`${command.method.toUpperCase()} ${command.path}`);
  renderResult(result);
}
