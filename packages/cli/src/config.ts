import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * CLI config resolution order (first match wins):
 *   1. Command-line flags (`--api-key`, `--project`, `--base-url`) handled by each command
 *   2. Environment variables (`CODESPAR_API_KEY`, `CODESPAR_PROJECT`, `CODESPAR_BASE_URL`)
 *   3. Config file at `~/.codespar/config.json`
 *
 * Writes go through `saveConfig()` which chmods the file to 0600 to keep
 * the API key out of other users' reach on shared machines.
 */
export interface CliConfig {
  apiKey?: string;
  project?: string;
  baseUrl?: string;
}

const CONFIG_DIR = join(homedir(), ".codespar");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export async function loadConfig(): Promise<CliConfig> {
  const fromEnv: CliConfig = {
    apiKey: process.env.CODESPAR_API_KEY,
    project: process.env.CODESPAR_PROJECT,
    baseUrl: process.env.CODESPAR_BASE_URL,
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
    baseUrl: fromEnv.baseUrl ?? fromFile.baseUrl ?? "https://api.codespar.dev",
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
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}
