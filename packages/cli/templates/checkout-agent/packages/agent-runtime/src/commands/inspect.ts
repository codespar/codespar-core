/**
 * `codespar-agent inspect <run-id> [--json] [--html <path>]`: the proof bundle
 * of section 11 read back as a timeline. Defaults to the terminal rendering;
 * `--json` follows the rule of section 14.5 — machine data on stdout, valid
 * JSON and nothing else, human messages on stderr.
 *
 * It reads the bundle and nothing else, so it works on any agent's run, and
 * on a folder copied off the machine that produced it.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { ProofBundle } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import { runsDir } from "../setup.js";
import { assembleTimeline, renderHtml, renderText } from "../inspect.js";

const USAGE = "usage: npm run inspect <run-id> [--json] [--html <file>]";

export function inspect(agent: Agent, argv: string[]): number {
  const say = (line: string) => stderr.write(line + "\n");
  let json = false;
  let html: string | undefined;
  let runId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--html") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        say(`--html needs a file path\n${USAGE}`);
        return 2;
      }
      html = value;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      say(USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      say(`unknown argument ${a}\n${USAGE}`);
      return 2;
    } else if (runId === undefined) runId = a;
    else {
      say(`inspect takes one run id (got ${runId} and ${a})\n${USAGE}`);
      return 2;
    }
  }

  const runs = runsDir(agent);
  if (!runId) {
    say(USAGE);
    say(available(runs));
    return 2;
  }

  // An unknown run id is a refusal a person can act on, never a stack trace.
  const bundle = ProofBundle.open(runs, runId);
  if (!bundle) {
    say(`no proof bundle for run ${runId}: nothing at ${resolve(runs, runId)}`);
    say(available(runs));
    return 1;
  }

  // A bundle half-written by a run that was killed is exactly when somebody looks at it: say which file is unreadable, do not throw a stack at them.
  let report;
  try {
    report = assembleTimeline(bundle);
  } catch (err) {
    say(`the bundle at ${bundle.dir} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    say("a file in it is missing or not valid JSON; the folder is the run's own output and is safe to delete and re-run");
    return 1;
  }

  if (html) {
    try {
      writeFileSync(html, renderHtml(report));
    } catch (err) {
      say(`could not write ${resolve(html)}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    say(`wrote ${resolve(html)} — one file, no network, opens from disk`);
  }
  if (json) stdout.write(JSON.stringify(report) + "\n");
  else stdout.write(renderText(report));
  return 0;
}

/** What the person can inspect instead. Bounded: a long-lived agent has many runs and this is an error message, not a listing command. */
function available(runs: string): string {
  if (!existsSync(runs)) return `no runs yet: ${runs} does not exist. Run the agent once, then inspect the run id it printed.`;
  const ids = readdirSync(runs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  if (!ids.length) return `no runs yet in ${runs}. Run the agent once, then inspect the run id it printed.`;
  const shown = ids.slice(0, 10);
  return `runs in ${runs}${ids.length > shown.length ? ` (newest ${shown.length} of ${ids.length})` : ""}:\n${shown.map((id) => `  ${id}`).join("\n")}`;
}
