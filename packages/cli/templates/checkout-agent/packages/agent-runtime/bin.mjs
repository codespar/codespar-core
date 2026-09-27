#!/usr/bin/env node
/**
 * `codespar-agent <command> [args]`. The agent is the working directory (or
 * the nearest ancestor holding an `agent.yaml`), so an agent's package.json
 * script is the command and nothing else.
 *
 * The repository has no build step: the TypeScript runs through tsx, which
 * needs the loader flag on the process that imports it. So this launcher is
 * a real process boundary — the same one `node --import tsx src/main.ts`
 * was before the runner moved here.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./src/cli.ts", import.meta.url));
// Resolved from THIS file and not from the working directory: `verify` runs
// wherever the receipt file is, which is usually not inside this repository,
// and a bare "tsx" would be looked up next to the caller's cwd and not found.
let loader = "tsx";
try {
  loader = import.meta.resolve("tsx");
} catch {
  // Left as the bare specifier: the error a missing tsx raises is the same
  // one it raised before, and it names the package.
}
const result = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", loader, cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
