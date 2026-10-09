/**
 * Two names for the same two settings. The kit reads `CODESPAR_API_URL` and
 * `CODESPAR_PROJECT_ID`; the CodeSpar CLI (`@codespar/cli`) reads
 * `CODESPAR_BASE_URL` and `CODESPAR_PROJECT`. A shell prepared for one of them
 * left the other on its default, production, with nothing said: a staging key
 * then meets the wrong deployment.
 *
 * The kit takes the CLI's names as aliases of its own, and a command that
 * talks to the API refuses to start when the two disagree. Only the
 * environment and the agent's `.env` are read: the CLI's own config file
 * (`~/.codespar/config.json`, what `codespar login` writes) is not.
 */
import { readDotEnv } from "./setup.js";

const PAIRS: ReadonlyArray<{ kit: string; cli: string; same: (a: string, b: string) => boolean }> = [
  { kit: "CODESPAR_API_URL", cli: "CODESPAR_BASE_URL", same: (a, b) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "") },
  { kit: "CODESPAR_PROJECT_ID", cli: "CODESPAR_PROJECT", same: (a, b) => a === b },
];

export class EnvNamesDisagreeError extends Error {
  constructor(kit: string, kitValue: string, cli: string, cliValue: string) {
    super(`${kit}=${kitValue} and ${cli}=${cliValue} disagree. The kit reads ${kit} and the CodeSpar CLI reads ${cli}; they must name the same thing. Set one of them, or both to the same value.`);
    this.name = "EnvNamesDisagreeError";
  }
}

/**
 * Makes the two names of each pair say one thing: whichever is set fills the
 * other, and two that are set and differ throw. Both are left set, so a later
 * reader of either name, and a later `.env`, finds the pair already decided.
 * An empty value counts as unset, as it does in the CLI.
 */
export function reconcileEnvNames(env: NodeJS.ProcessEnv = process.env): void {
  for (const { kit, cli, same } of PAIRS) {
    const kitValue = env[kit]?.trim() || undefined;
    const cliValue = env[cli]?.trim() || undefined;
    if (kitValue && cliValue && !same(kitValue, cliValue)) throw new EnvNamesDisagreeError(kit, kitValue, cli, cliValue);
    const value = kitValue ?? cliValue;
    if (value !== undefined) env[kit] = env[cli] = value;
  }
}

/**
 * The agent's `.env` under the rule `readDotEnv` already has, extended to the
 * aliases: what the shell exported wins, and the file fills only what is
 * unset. The shell is reconciled first, so a name it set under either spelling
 * closes the pair before the file is read; then the file's own names are.
 *
 * It returns the disagreement instead of throwing it: only a command that is
 * about to use the URL or the project should stop on it.
 */
export function readAgentEnv(agentDir: string | undefined): EnvNamesDisagreeError | undefined {
  try {
    reconcileEnvNames();
    if (agentDir) readDotEnv(agentDir);
    reconcileEnvNames();
    return undefined;
  } catch (err) {
    if (!(err instanceof EnvNamesDisagreeError)) throw err;
    // The shell disagreed with itself before the file was read: the file is still owed, for the key it may hold.
    if (agentDir) readDotEnv(agentDir);
    return err;
  }
}
