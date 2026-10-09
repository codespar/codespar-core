/**
 * `codespar-agent start`                              interactive terminal
 * `codespar-agent start --input "..."`                one turn, no prompt
 * `codespar-agent start --scenario happy-path`        a scenario pack, every mode it declares
 * `codespar-agent start --channel whatsapp`           the conversation channel
 *
 * `--json` puts machine data on stdout (valid JSON, nothing else) and the
 * human messages on stderr.
 *
 * A one-shot prints, after the reply, what the run did as the engine counts
 * it (`outcome.ts`), and exits by it: see `EXIT_CODES`.
 */
import { statSync } from "node:fs";
import { stderr, stdout } from "node:process";
import { relative, resolve } from "node:path";
import { CORE_STRINGS, NotATestKeyError, WHATSAPP_LANGUAGE, declaredReplies, loadManifest, parseLocale, resolveLocale, testKeyProblem, resolveFixedClock, type ApprovalMode, type ChannelName, type Locale } from "@codespar/agent-core";
import { join } from "node:path";
import type { Agent } from "../agent.js";
import type { RailKind } from "../kit.js";
import { envFileOf, resolveProvider, resolveRailKind, setup, type ProviderKind } from "../setup.js";
import { checkScenario, listScenarios, loadScenario, runScenario, scenariosDir } from "../scenarios.js";
import { closeTerminal, defaultAsk, handleExecution, interactive } from "../terminal.js";
import { loadTemplates, resolveConversation } from "../channels/index.js";
import { startWhatsApp, type WhatsAppBackendName } from "./start-whatsapp.js";
import { outcomeExitCode, refusalLine, sayOutcome } from "../outcome.js";

const EXIT_CODES = `exit (--input): 0 nothing failed (settled, already paid, denied, expired or still open: the last line counts each payment); 1 a payment failed or a line was refused before a draft, and 1 wins over 3; 3 nothing failed and an execution of this run was left executing (npm run reconcile). A line an earlier run still holds is open and exits 0.`;

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

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
  /** The language of what the code prints; absent means agent.yaml's `locale`, else pt-BR. */
  locale?: Locale;
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
    else if (a === "--locale") args.locale = parseLocale(next());
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
    stderr.write(`${usage}\n${EXIT_CODES}\n`);
    return 0;
  }
  const say = (line: string) => stderr.write(line + "\n");
  // Fixed for the run, and for a conversation: the proposal and its approval are asked in the same language.
  const locale = resolveLocale(args.locale, loadManifest(join(agent.dir, "agent.yaml")).manifest);

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
  const keyProblem = railKind === "api" ? testKeyProblem(process.env["CODESPAR_API_KEY"]) : undefined;
  if (keyProblem) {
    say(new NotATestKeyError(keyProblem, envFileOf(agent.dir)).message);
    return 1;
  }

  // A recording that is not there is said by its path, before a mandate is asked for or a run is opened.
  if (args.transcript !== undefined && !isFile(args.transcript)) {
    say(`no transcript at ${args.transcript}`);
    return 1;
  }

  if (args.scenario) return runScenarioCommand(agent, args, railKind, locale, say);

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
    const ok = await agent.kit.ensureMandate({ agentDir: agent.dir, argv, locale, say, railKind, oneShot: args.input !== undefined, ask: defaultAsk });
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
  // A first turn that is a TAP is looked up by the intent the tap stands for in the run's language, which is what the model is handed.
  const firstTurn = args.scripted ? conversationScript?.turns[0] : undefined;
  const firstInput = args.input ?? firstTurn?.text ?? (firstTurn?.reply ? declaredReplies(loadTemplates(agent), WHATSAPP_LANGUAGE[locale]).get(firstTurn.reply.id)?.intent : undefined);

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

  const s = setup(agent, { mode: args.mode, rail: railKind, provider, transcript, now, say, locale });
  if (args.payer) s.payer?.behave(args.payer);
  const approver = { id: args.user ?? s.kit.labels.defaultUser, channel: "terminal" };
  const startedAt = Date.now();
  try {
    if (args.channel === "whatsapp") {
      s.conversation = conversationScript;
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
    // Counted from the engine, printed whatever the reply says: a recorded reply cannot know what this run found.
    const { executions, refusals, outcome, line } = sayOutcome(s, result.not_run);
    // A request refused before a draft left no execution to describe: said here with the engine's own reason, or the terminal would be silent about it.
    for (const refusal of refusals) say(refusalLine(refusal));
    const payload = s.kit.oneShotPayload({ setup: s, reply: result.reply, toolCalls: result.tool_calls, executions, startedAt });
    // `run_outcome`, not `outcome`: the payload is the kit's, and a kit may name a field of its own that.
    if (args.json) stdout.write(JSON.stringify({ ...payload, run_outcome: outcome, refused_before_draft: refusals }) + "\n");
    else stdout.write(`${result.reply}\n${line}\n`);
    return outcomeExitCode(outcome, executions);
  } finally {
    closeTerminal();
    s.close();
  }
}

async function runScenarioCommand(agent: Agent, args: Args, railKind: RailKind, locale: Locale, say: (l: string) => void): Promise<number> {
  const text = CORE_STRINGS[locale];
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
      locale,
    });
    const check = checkScenario(scenario, run);
    for (const reply of run.replies) say(text.scenarioReply(reply));
    // Seconds are said only where a clock measured them. On the stub the clock is the scenario's, ticking a second per read: its "16s" is a count of reads in a run that took under one.
    const measured = agent.settlement === "await-payer" && run.rail === "api" ? run.cycle_seconds : undefined;
    say(check.ok ? text.scenarioOk(measured, relative(process.cwd(), run.bundle_dir)) : `== FAIL: ${check.failures.join("; ")}`);
    results.push({ mode, ok: check.ok, failures: check.failures, run });
  }
  if (args.json) stdout.write(JSON.stringify({ scenario: scenario.name, ...(picksRail ? { rail } : {}), results }) + "\n");
  return results.every((r) => r.ok) ? 0 : 1;
}
