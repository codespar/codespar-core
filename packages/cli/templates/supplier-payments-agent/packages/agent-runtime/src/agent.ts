/**
 * Which agent a command is running. Every function of the runner takes one:
 * the directory that holds `agent.yaml` and the kit that directory exports.
 * Nothing else in the runner knows an agent's name.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentKit, Settlement } from "./kit.js";
import { defaultKit } from "./default-kit.js";

export interface Agent {
  /** The directory holding `agent.yaml`. */
  dir: string;
  kit: AgentKit;
  /** `bills-agent` -> `bills`: the temp-directory and env-variable prefix. */
  slug: string;
  settlement: Settlement;
}

/** The nearest ancestor of `from` that holds an `agent.yaml`, `from` included. */
export function findAgentDir(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "agent.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function slugOf(agentDir: string): string {
  const m = /^\s*name:\s*"?([a-z0-9-]+)"?/m.exec(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
  return (m?.[1] ?? "agent").replace(/-agent$/, "");
}

/** The handle an agent's `src/kit.ts` exports: `export const agent = defineAgent(import.meta.url, kit)`. */
export function defineAgent(moduleUrl: string, kit: AgentKit): Agent {
  const dir = findAgentDir(dirname(fileURLToPath(moduleUrl)));
  if (!dir) throw new Error(`no agent.yaml above ${moduleUrl}`);
  return { dir, kit, slug: slugOf(dir), settlement: kit.settlement ?? "immediate" };
}

/**
 * The agent a `codespar-agent` invocation runs against: `CODESPAR_AGENT_DIR`,
 * else the nearest `agent.yaml` at or above the working directory. Its kit is
 * `src/kit.ts` (or `kit.ts`) if it ships one, and `defaultKit` if it does not.
 */
export async function loadAgent(dir?: string): Promise<Agent> {
  const start = dir ?? process.env["CODESPAR_AGENT_DIR"] ?? process.cwd();
  const agentDir = findAgentDir(start);
  if (!agentDir) throw new Error(`no agent.yaml at or above ${start}; run the command inside an agent directory`);
  for (const rel of ["src/kit.ts", "kit.ts"]) {
    const path = join(agentDir, rel);
    if (!existsSync(path)) continue;
    const module = (await import(pathToFileURL(path).href)) as { agent?: Agent; kit?: AgentKit; default?: AgentKit };
    if (module.agent) return module.agent;
    const kit = module.kit ?? module.default;
    if (!kit) throw new Error(`${rel} must export \`agent\` (defineAgent) or \`kit\``);
    return { dir: agentDir, kit, slug: slugOf(agentDir), settlement: kit.settlement ?? "immediate" };
  }
  return { dir: agentDir, kit: defaultKit, slug: slugOf(agentDir), settlement: "immediate" };
}

/** `BILLS_STATE_DIR` for `bills-agent`: the test-only overrides are namespaced by the agent. */
export function envName(agent: Agent, name: string): string {
  return `${agent.slug.toUpperCase().replace(/-/g, "_")}_${name}`;
}
