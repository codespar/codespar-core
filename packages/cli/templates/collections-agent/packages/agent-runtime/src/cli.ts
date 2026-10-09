/**
 * `codespar-agent <command> [args]`. The agent is the working directory; the
 * command is this runner's, the same for every agent. What differs between
 * agents is behind `kit`.
 */
import { stderr } from "node:process";
import { loadAgent, type Agent } from "./agent.js";
import { NotATestKeyError } from "@codespar/agent-core";
import { readAgentEnv } from "./env.js";
import { envFileOf, localeFlag, resolveRailKind } from "./setup.js";
import { loadManifest, resolveLocale } from "@codespar/agent-core";
import { join } from "node:path";
import { check } from "./commands/check.js";
import { decide } from "./commands/decide.js";
import { runEval } from "./commands/eval.js";
import { inspect } from "./commands/inspect.js";
import { poll } from "./commands/poll.js";
import { reconcile } from "./commands/reconcile.js";
import { rerun } from "./commands/rerun.js";
import { resume } from "./commands/resume.js";
import { start } from "./commands/start.js";
import { verify } from "./commands/verify.js";
import { webhook } from "./commands/webhook.js";

const COMMANDS = ["start", "consent", "approve", "deny", "resume", "rerun", "reconcile", "inspect", "poll", "webhook", "check", "eval", "verify"] as const;

/** Commands that are not about an agent. `verify` reads a receipt file and a
 *  public key set, which is all a party outside CodeSpar has: requiring an
 *  `agent.yaml` above the working directory would mean the verifier needed the
 *  agent that produced the receipt, and the whole point is that it does not. */
const AGENTLESS: readonly string[] = ["verify"];

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const rest = [...argv];
  let dir: string | undefined;
  const at = rest.indexOf("--agent");
  if (at >= 0) {
    dir = rest[at + 1];
    rest.splice(at, dir === undefined ? 1 : 2);
  }
  const first = rest[0];
  const command = first !== undefined && !first.startsWith("-") ? rest.shift()! : "start";
  if (!(COMMANDS as readonly string[]).includes(command)) {
    stderr.write(`unknown command ${command}; one of: ${COMMANDS.join(", ")}\n`);
    return 2;
  }
  if (AGENTLESS.includes(command)) return verify(rest);
  const agent = await loadAgent(dir);
  // The CLI's names for the deployment and the project are aliases of the kit's. Two that disagree stop a command that talks to the API; on the stub rail neither is read, and the run goes on.
  const disagreement = readAgentEnv(agent.dir);
  const railFlag = rest.includes("--rail") ? rest[rest.indexOf("--rail") + 1] : undefined;
  if (disagreement && resolveRailKind(process.env, railFlag === "api" || railFlag === "stub" ? railFlag : undefined) === "api") {
    stderr.write(disagreement.message + "\n");
    return 1;
  }
  try {
    return await run(agent, command, rest);
  } catch (err) {
    // A key refusal is the first thing a newcomer meets (#50): one sentence naming the file this agent reads, never a stack trace.
    if (err instanceof NotATestKeyError) {
      stderr.write(new NotATestKeyError(err.problem, envFileOf(agent.dir)).message + "\n");
      return 1;
    }
    throw err;
  }
}

async function run(agent: Agent, command: string, argv: string[]): Promise<number> {
  const awaitsPayer = agent.settlement === "await-payer";
  switch (command) {
    case "start":
      return start(agent, argv);
    case "consent": {
      if (!agent.kit.consent) {
        stderr.write(`${agent.slug}: this agent has no consent step (its policy is its own file, not a signed mandate)\n`);
        return 2;
      }
      let locale;
      try {
        locale = resolveLocale(localeFlag(argv), loadManifest(join(agent.dir, "agent.yaml")).manifest);
      } catch (err) {
        stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      return agent.kit.consent({ agentDir: agent.dir, argv, locale, say: (l) => void stderr.write(l + "\n") });
    }
    case "approve":
      return decide(agent, "approve", argv);
    case "deny":
      return decide(agent, "deny", argv);
    case "resume":
      return resume(agent, argv);
    case "rerun":
      return rerun(agent, argv);
    case "reconcile":
      return reconcile(agent, argv);
    case "inspect":
      return inspect(agent, argv);
    case "check":
      return check(agent, argv);
    case "eval":
      return runEval(agent, argv);
    case "poll":
    case "webhook": {
      if (!awaitsPayer) {
        stderr.write(`${agent.slug}: ${command} is for an agent that waits for a payer; this one settles on the rail's answer\n`);
        return 2;
      }
      return command === "poll" ? poll(agent, argv) : webhook(agent, argv);
    }
    default:
      stderr.write(`unknown command ${command}\n`);
      return 2;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
