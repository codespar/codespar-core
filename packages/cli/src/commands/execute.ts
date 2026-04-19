import { readFile } from "node:fs/promises";
import { CodeSpar } from "@codespar/sdk";
import { CliError } from "../config.js";
import { json, success } from "../output.js";

interface ExecuteOptions {
  server?: string;
  input?: string;
  inputFile?: string;
  user?: string;
  apiKey: string;
  baseUrl: string;
  json?: boolean;
}

/**
 * One-shot tool execution. Opens a session, calls execute(), closes.
 * For multi-step flows or long sessions, use the SDK directly.
 */
export async function executeCommand(toolName: string, opts: ExecuteOptions): Promise<void> {
  if (!toolName) throw new CliError("Tool name is required. Example: `codespar execute codespar_pay --input '{...}'`");
  if (!opts.server) throw new CliError("--server is required (e.g. --server asaas)");

  const input = await resolveInput(opts);
  const userId = opts.user ?? "cli-user";

  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  const session = await cs.create(userId, { servers: [opts.server] });

  try {
    const result = await session.execute(toolName, input);

    if (opts.json) {
      json(result);
      return;
    }

    if (result.success) {
      success(`${toolName} succeeded in ${result.duration ?? "?"}ms`);
    } else {
      process.stderr.write(`Tool call failed: ${result.error ?? "unknown error"}\n`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    await session.close();
  }
}

async function resolveInput(opts: ExecuteOptions): Promise<Record<string, unknown>> {
  if (opts.input && opts.inputFile) {
    throw new CliError("Pass either --input or --input-file, not both.");
  }
  if (opts.inputFile) {
    const raw = await readFile(opts.inputFile, "utf-8");
    return parseJson(raw, opts.inputFile);
  }
  if (opts.input) return parseJson(opts.input, "--input");
  return {};
}

function parseJson(raw: string, source: string): Record<string, unknown> {
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
