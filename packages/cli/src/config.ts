import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_BASE_URL } from "./did.js";

/**
 * CLI config resolution order (first match wins):
 *   1. Command-line flags (`--api-key`, `--project`, `--base-url`) handled by each command
 *   2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_PROJECT`, `CODESPAR_BASE_URL`,
 *      `CODESPAR_DID_DOMAINS`)
 *   3. Config file at `~/.codespar/config.json`
 *
 * Writes go through `saveConfig()` which chmods the file to 0600 to keep
 * the API key out of other users' reach on shared machines.
 */
export interface CliConfig {
  apiKey?: string;
  project?: string;
  baseUrl?: string;
  /**
   * Identity hosts the API's DID route may answer for in `mandate verify`
   * (`CODESPAR_DID_DOMAINS`, comma-separated; or `didDomains` in the file).
   * Set once for a staging or self-hosted API instead of `--did-domain` on
   * every call.
   */
  didDomains?: string[];
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
export function parseDidDomains(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

const CONFIG_DIR = join(homedir(), ".codespar");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<CliConfig> {
  // `|| undefined` e nao `??`: uma variavel exportada VAZIA (`export
  // CODESPAR_BASE_URL=`, comum num `env` de CI) chega como string vazia, que
  // `??` deixa passar. O resultado era um cliente com base URL vazia em vez
  // do que esta no arquivo.
  const fromEnv: CliConfig = {
    apiKey: process.env.CODESPAR_API_KEY || undefined,
    project: process.env.CODESPAR_PROJECT || undefined,
    baseUrl: process.env.CODESPAR_BASE_URL || undefined,
    didDomains: parseDidDomains(process.env.CODESPAR_DID_DOMAINS),
  };

  let fromFile: CliConfig = {};
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    fromFile = JSON.parse(raw) as CliConfig;
  } catch {
    // No config file yet — that's fine, login will create it.
  }

  // Env wins over file; command-line flags override both at the call site.
  return {
    apiKey: fromEnv.apiKey ?? fromFile.apiKey,
    project: fromEnv.project ?? fromFile.project,
    baseUrl: fromEnv.baseUrl ?? fromFile.baseUrl ?? DEFAULT_BASE_URL,
    didDomains:
      fromEnv.didDomains ??
      (Array.isArray(fromFile.didDomains)
        ? fromFile.didDomains.filter((h): h is string => typeof h === "string")
        : undefined),
  };
}

export async function saveConfig(patch: Partial<CliConfig>): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });

  let existing: CliConfig = {};
  try {
    existing = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as CliConfig;
  } catch {
    // fresh file
  }

  const next = { ...existing, ...patch };
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", "utf-8");
  // File contains an API key — restrict to owner only.
  await chmod(CONFIG_FILE, 0o600);
}

export function requireApiKey(config: CliConfig): string {
  if (!config.apiKey) {
    throw new CliError(
      "Not logged in. Run `codespar login` or set CODESPAR_API_KEY.",
    );
  }
  return config.apiKey;
}

/**
 * Error that should be printed to stderr and exit 1 without a stack trace.
 * Anything else bubbling up is treated as a bug and prints the stack.
 */
export class CliError extends Error {
  /**
   * A stable, machine-readable name for the refusal, carried into the
   * `--json` error document as `error.code`. Optional: most refusals are
   * one-offs a script has no reason to branch on, and the message is enough.
   */
  readonly code?: string;

  constructor(message: string, opts: { code?: string } = {}) {
    super(message);
    this.name = "CliError";
    this.code = opts.code;
  }
}
