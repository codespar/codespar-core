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
  project?: string;
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

  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, projectId: opts.project });
  const session = await cs.create(userId, { servers: [opts.server] });

  try {
    const result = await session.execute(toolName, input);

    // O envelope sai ANTES da recusa, inclusive em `--json`: quem le por
    // maquina precisa do corpo, e quem encadeia com `&&` precisa do codigo de
    // saida. Antes o comando escrevia "Tool call failed" no stderr e RETORNAVA,
    // entao a mesma resposta saia 0 aqui e 1 por `codespar tool <nome>`.
    if (opts.json) json(result);
    else {
      if (result.success) success(`${toolName} succeeded in ${result.duration ?? "?"}ms`);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    }

    if (!result.success) {
      throw new CliError(`${toolName} failed: ${result.error ?? "unknown error"}`);
    }
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
