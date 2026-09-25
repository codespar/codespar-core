/**
 * `codespar-agent start`                              interactive terminal
 * `codespar-agent start --input "..."`                one turn, no prompt
 * `codespar-agent start --scenario happy-path`        a scenario pack, every mode it declares
 * `codespar-agent start --channel whatsapp`           the conversation channel
 *
 * `--json` puts machine data on stdout (valid JSON, nothing else) and the
 * human messages on stderr.
 */
import { stderr, stdout } from "node:process";
import { relative, resolve } from "node:path";
import { NotATestKeyError, isTestKey, loadManifest, resolveFixedClock, type ApprovalMode, type ChannelName } from "@codespar/agent-core";
import { join } from "node:path";
import type { Agent } from "../agent.js";
import type { RailKind } from "../kit.js";
import { resolveProvider, resolveRailKind, setup, type ProviderKind } from "../setup.js";
import { checkScenario, listScenarios, loadScenario, runScenario, scenariosDir } from "../scenarios.js";
import { closeTerminal, defaultAsk, handleExecution, interactive } from "../terminal.js";
import { resolveConversation } from "../channels/index.js";
import { startWhatsApp, type WhatsAppBackendName } from "./start-whatsapp.js";

interface Args {
  input?: string;
  scenario?: string;
  mode?: ApprovalMode;
  json: boolean;
  decision?: "approve" | "deny";
  provider?: ProviderKind;
  transcript?: string;
  rail?: RailKind;
  user?: string;
  wait?: number;
  simulatePayer: boolean;
  payer?: "pays" | "expires" | "never";
  /** ISO 8601 instant the run is pinned to (the guardrails read it instead of the wall clock). */
  now?: string;
  /** Which channel the person is on. `terminal` is every agent's; `whatsapp` needs a conversation. */
  channel: ChannelName;
  backend?: WhatsAppBackendName;
  conversation?: string;
  /** Replay the conversation's turns instead of reading them from the keyboard. */
  scripted: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], awaitsPayer: boolean): Args {
  const args: Args = { json: false, simulatePayer: false, help: false, channel: "terminal", scripted: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--input") args.input = next();
    else if (a === "--scenario") args.scenario = next();
    else if (a === "--mode") {
      const v = next();
      if (v !== "human" && v !== "mandate") throw new Error("--mode must be human or mandate");
      args.mode = v;
    } else if (a === "--json") args.json = true;
    else if (a === "--approve") args.decision = "approve";
    else if (a === "--deny") args.decision = "deny";
    else if (a === "--provider") {
      const v = next();
      if (v !== "anthropic" && v !== "replay") throw new Error("--provider must be anthropic or replay");
      args.provider = v;
    } else if (a === "--transcript") args.transcript = next();
    else if (a === "--rail") {
      const v = next();
      if (v !== "stub" && v !== "api") throw new Error("--rail must be stub or api");
      args.rail = v;
    } else if (a === "--user") args.user = next();
    else if (awaitsPayer && a === "--wait") {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0) throw new Error("--wait must be a number of seconds");
      args.wait = v;
    } else if (awaitsPayer && a === "--simulate-payer") args.simulatePayer = true;
    else if (awaitsPayer && a === "--payer") {
      const v = next();
      if (v !== "pays" && v !== "expires" && v !== "never") throw new Error("--payer must be pays, expires or never");
      args.payer = v;
    } else if (a === "--now") args.now = next();
    else if (a === "--channel") {
      const v = next();
      if (v !== "terminal" && v !== "whatsapp") throw new Error("--channel must be terminal or whatsapp");
      args.channel = v;
    } else if (a === "--backend") {
      const v = next();
      if (v !== "simulator" && v !== "cloud-api") throw new Error("--backend must be simulator or cloud-api");
      args.backend = v;
    } else if (a === "--conversation") args.conversation = next();
    else if (a === "--scripted") args.scripted = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

export async function start(agent: Agent, argv: string[]): Promise<number> {
  const awaitsPayer = agent.settlement === "await-payer";
  const usage = agent.kit.usage(loadManifest(join(agent.dir, "agent.yaml")));
  let args: Args;
  try {
    args = parseArgs(argv, awaitsPayer);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage}\n`);
    return 2;
  }
  if (args.help) {
    stderr.write(usage + "\n");
    return 0;
  }
  const say = (line: string) => stderr.write(line + "\n");

  // A pinned instant makes the guardrails deterministic: the CI runs the fixture inside the declared hours whatever the hour is.
  let now: (() => Date) | undefined;
  try {
    now = resolveFixedClock(args.now, process.env);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n${usage}\n`);
    return 2;
  }

  // Sandbox by construction: a live key dies here, before anything else runs.
  const railKind = resolveRailKind(process.env, args.rail);
  if (railKind === "api" && !isTestKey(process.env["CODESPAR_API_KEY"])) {
    say(new NotATestKeyError().message);
    return 1;
  }

  if (args.scenario) return runScenarioCommand(agent, args, railKind, say);

  // A channel is a conversation, so the flags a one-shot and a scenario pack use have no meaning on one.
  if (args.channel === "whatsapp" && (args.input !== undefined || args.scenario !== undefined)) {
    say("--channel whatsapp is a conversation: it takes its turns from channels/whatsapp/, not from --input or --scenario");
    return 2;
  }
  if (args.channel !== "whatsapp" && (args.backend !== undefined || args.conversation !== undefined || args.scripted)) {
    say("--backend, --conversation and --scripted belong to --channel whatsapp");
    return 2;
  }
  if (args.channel === "whatsapp" && !loadManifest(join(agent.dir, "agent.yaml")).manifest.channels.includes("whatsapp")) {
    say(`${agent.slug} does not declare the whatsapp channel in agent.yaml`);
    return 2;
  }

  if (agent.kit.ensureMandate) {
    const ok = await agent.kit.ensureMandate({ agentDir: agent.dir, argv, say, railKind, oneShot: args.input !== undefined, ask: defaultAsk });
    if (!ok) return 1;
  }

  // The first thing the person says: the `--input` of a one-shot, or the first scripted turn of a conversation.
  let conversationScript;
  try {
    conversationScript = args.channel === "whatsapp" ? resolveConversation(agent, args.conversation) : undefined;
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const firstInput = args.input ?? (args.scripted ? conversationScript?.turns[0].text : undefined);

  // No model: replay the recorded scenario whose first turn is what the person said first.
  let transcript = args.transcript;
  const provider = resolveProvider(process.env, args.provider);
  if (provider === "replay" && !transcript && firstInput) {
    const match = listScenarios(agent).map((n) => loadScenario(agent, n)).find((s) => s.turns[0].input === firstInput);
    if (match) transcript = resolve(scenariosDir(agent), match.transcript);
    else {
      say(`no ANTHROPIC_API_KEY and no recorded transcript for that input. Set the key, pass --transcript, or use one of: ${listScenarios(agent).map((n) => `"${loadScenario(agent, n).turns[0].input}"`).join(", ")}`);
      return 1;
    }
  }

  const s = setup(agent, { mode: args.mode, rail: railKind, provider, transcript, now, say });
  if (args.payer) s.payer?.behave(args.payer);
  const approver = { id: args.user ?? s.kit.labels.defaultUser, channel: "terminal" };
  const startedAt = Date.now();
  try {
    if (args.channel === "whatsapp") {
      return await startWhatsApp({
        agent,
        setup: s,
        script: conversationScript!,
        backend: args.backend ?? "simulator",
        scripted: args.scripted,
        approver: { id: approver.id, channel: "whatsapp" },
        json: args.json,
        startedAt,
        say,
        ...(args.decision ? { decision: args.decision } : {}),
        ...(args.wait !== undefined ? { waitSeconds: args.wait } : {}),
        simulatePayer: args.simulatePayer,
        now,
      });
    }
    const runtime = s.makeRuntime();
    if (!args.input) {
      await interactive({ setup: s, approver, runtime, say, waitSeconds: args.wait, simulatePayer: args.simulatePayer });
      return 0;
    }
    const loop = s.makeLoop(runtime, (execution) =>
      handleExecution(execution, { setup: s, approver, decision: args.decision ?? "none", say, waitSeconds: args.wait, simulatePayer: args.simulatePayer, ...(args.json ? { tell: say } : {}) }),
    );
    const result = await loop.turn(args.input);
    const executions = s.engine.list().filter((e) => e.run_id === s.runId);
    const payload = s.kit.oneShotPayload({ setup: s, reply: result.reply, toolCalls: result.tool_calls, executions, startedAt });
    if (args.json) stdout.write(JSON.stringify(payload) + "\n");
    else stdout.write(result.reply + "\n");
    return executions.some((e) => e.state === "executing") ? 3 : 0;
  } finally {
    closeTerminal();
    s.close();
  }
}

async function runScenarioCommand(agent: Agent, args: Args, railKind: RailKind, say: (l: string) => void): Promise<number> {
  const scenario = loadScenario(agent, args.scenario!);
  const picksRail = agent.kit.scenarioRail === "requested";
  const rail: RailKind = picksRail ? railKind : "stub";
  if (picksRail && !scenario.rails.includes(rail)) {
    say(`scenario ${scenario.name} runs on ${scenario.rails.join("/")} only (asked: ${rail})`);
    return 2;
  }
  const modes = args.mode ? [args.mode] : scenario.modes;
  const results = [];
  for (const mode of modes) {
    say(`== scenario ${scenario.name} — approval: ${mode}${picksRail ? ` — rail: ${rail}` : ""}`);
    say(scenario.description);
    const run = await runScenario(agent, scenario, {
      mode,
      rail,
      say: args.json ? () => undefined : say,
      ...(picksRail ? { tell: args.json ? () => undefined : (l: string) => void stdout.write(l + "\n") } : {}),
      waitSeconds: args.wait,
    });
    const check = checkScenario(scenario, run);
    for (const reply of run.replies) say(`agente: ${reply}`);
    say(check.ok ? `== ok — ${agent.settlement === "await-payer" ? `${run.cycle_seconds}s — ` : ""}bundle em ${relative(process.cwd(), run.bundle_dir)}` : `== FAIL: ${check.failures.join("; ")}`);
    results.push({ mode, ok: check.ok, failures: check.failures, run });
  }
  if (args.json) stdout.write(JSON.stringify({ scenario: scenario.name, ...(picksRail ? { rail } : {}), results }) + "\n");
  return results.every((r) => r.ok) ? 0 : 1;
}
