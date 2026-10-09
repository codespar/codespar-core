/**
 * Where a run's proof bundle lives. A run a person made (`npm start`, a
 * scenario pack run by name) is `runs/<run-id>`. `npm run eval` writes dozens
 * per pass, and they used to land beside the person's own, so the folder a
 * person looks in was mostly the suite's. They go to `runs/eval/<run-id>`.
 *
 * A run id is still all `inspect` and `rerun` take: an eval run is found by
 * its id alone, and `eval/<run-id>` is accepted too.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ProofBundle } from "@codespar/agent-core";
import type { Agent } from "./agent.js";
import { runsDir } from "./setup.js";

/** The folder name under `runs/` that holds what the eval suite wrote. Never a run id: every run id starts with `run_`. */
export const EVAL_RUNS = "eval";

export function evalRunsDir(agent: Agent, env: NodeJS.ProcessEnv = process.env): string {
  return join(runsDir(agent, env), EVAL_RUNS);
}

/** The bundle of a run by its id, a person's or the eval suite's, and the folder it was found in. */
export function openRun(agent: Agent, runId: string, env: NodeJS.ProcessEnv = process.env): { bundle: ProofBundle; runsDir: string } | undefined {
  const own = runsDir(agent, env);
  const id = runId.startsWith(`${EVAL_RUNS}/`) ? runId.slice(EVAL_RUNS.length + 1) : runId;
  // The folder itself is not a run, and neither is a path that climbs out of the runs folder.
  if (id === "" || id === EVAL_RUNS || id.includes("/") || id.includes("\\") || id === "." || id === "..") return undefined;
  for (const dir of runId === id ? [own, evalRunsDir(agent, env)] : [evalRunsDir(agent, env)]) {
    const bundle = ProofBundle.open(dir, id);
    if (bundle) return { bundle, runsDir: dir };
  }
  return undefined;
}

/** Run ids in a folder, newest first. Run ids start with a timestamp or a case name, so the order is by name. */
function idsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== EVAL_RUNS)
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** The runs a person made, and how many the eval suite left beside them. */
export function listRuns(agent: Agent, env: NodeJS.ProcessEnv = process.env): { dir: string; ids: string[]; evalDir: string; evalCount: number } {
  const dir = runsDir(agent, env);
  const evalDir = evalRunsDir(agent, env);
  return { dir, ids: idsIn(dir), evalDir, evalCount: idsIn(evalDir).length };
}
