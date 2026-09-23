/**
 * `npm start`                                  interactive terminal
 * `npm start -- --input "pague a escola de outubro"`   one turn, no prompt
 * `npm start -- --scenario happy-path`         a scenario pack, both modes it declares
 *
 * `--json` puts machine data on stdout (valid JSON, nothing else) and the
 * human messages on stderr.
 */
import { stderr, stdout } from "node:process";
import { relative, resolve } from "node:path";
import { NotATestKeyError, isTestKey } from "@codespar/agent-core";
import { closeTerminal, defaultAsk, handleExecution, interactive } from "../channels/terminal/index.js";
import { runEmbeddedConsent, loadLocalMandate } from "./modules/embedded-consent.js";
import { checkScenario, listScenarios, loadScenario, runScenario, scenariosDir } from "./scenarios.js";
import { AGENT_DIR, MANDATE_PATH, NoMandateError, readDotEnv, resolveRailKind, setup, type RailKind } from "./setup.js";
import { loadMandate, createCodeSparClient } from "@codespar/agent-core";

interface Args {
  input?: string;
  scenario?: string;
  mode?: "human" | "mandate";
  json: boolean;
  decision?: "approve" | "deny";
  provider?: "anthropic" | "replay";
  transcript?: string;
  rail?: RailKind;
  user: string;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, user: "usr_terminal", help: false };
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
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = `bills-agent
  npm start                                         interactive terminal
  npm start -- --input "pague a escola de outubro"  one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                    run a scenario pack (${"see scenarios/"})
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>  --json`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    stderr.write(USAGE + "\n");
    return 0;
  }
  readDotEnv();
  const say = (line: string) => stderr.write(line + "\n");

  if (args.scenario) return runScenarioCommand(args, say);

  // Sandbox by construction: a live key dies here, before anything else runs.
  const railKind = resolveRailKind(process.env, args.rail);
  if (railKind === "api" && !isTestKey(process.env["CODESPAR_API_KEY"])) {
    say(new NotATestKeyError().message);
    return 1;
  }

  // Embedded consent: with a test key and no signed mandate, the mandate is born first.
  if (railKind === "api" && !loadLocalMandate(MANDATE_PATH)) {
    if (args.input) {
      say(new NoMandateError().message);
      return 1;
    }
    const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: process.env["CODESPAR_API_URL"], projectId: process.env["CODESPAR_PROJECT_ID"] });
    const example = loadMandate(resolve(AGENT_DIR, "mandate.example.json"));
    await runEmbeddedConsent({ api, example, mandatePath: MANDATE_PATH, say, confirm: async (q: string) => /^(s|sim|y|yes)$/i.test((await defaultAsk(q)).trim()) });
  }

  // One-shot without a model: replay the recorded happy-path when the input is its first turn.
  let transcript = args.transcript;
  const provider = args.provider ?? (process.env["ANTHROPIC_API_KEY"] && process.env["ANTHROPIC_API_KEY"] !== "sk-ant-your_key_here" ? "anthropic" : "replay");
  if (provider === "replay" && !transcript && args.input) {
    const match = listScenarios().map(loadScenario).find((s) => s.turns[0].input === args.input);
    if (match) transcript = resolve(scenariosDir(), match.transcript);
    else {
      say(`no ANTHROPIC_API_KEY and no recorded transcript for that input. Set the key, pass --transcript, or use one of: ${listScenarios().map((n) => `"${loadScenario(n).turns[0].input}"`).join(", ")}`);
      return 1;
    }
  }

  const s = setup({ mode: args.mode, rail: railKind, provider, transcript, say });
  const approver = { id: args.user, channel: "terminal" };
  try {
    const runtime = s.makeRuntime();
    if (!args.input) {
      await interactive({ setup: s, approver, runtime, say });
      return 0;
    }
    const loop = s.makeLoop(runtime, (execution) => handleExecution(execution, { setup: s, approver, decision: args.decision ?? "none", say }));
    const result = await loop.turn(args.input);
    const executions = s.engine.list().filter((e) => e.run_id === s.runId);
    const payload = {
      run_id: s.runId,
      agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
      mode: s.mode,
      rail: s.railKind,
      mandate_id: s.mandate.id,
      actor: s.engine.agentActor,
      reply: result.reply,
      tool_calls: result.tool_calls,
      executions: executions.map((e) => ({
        id: e.id,
        state: e.state,
        reason: e.reason ?? null,
        escalation: e.escalation ?? null,
        total_minor: e.total,
        items: e.items.map((i) => ({ beneficiary: i.beneficiary, amount_minor: i.amount })),
        approval_id: e.approval_id ?? null,
        receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
      })),
      receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
      bundle_dir: relative(process.cwd(), s.bundle.dir),
    };
    if (args.json) stdout.write(JSON.stringify(payload) + "\n");
    else stdout.write(result.reply + "\n");
    return executions.some((e) => e.state === "executing") ? 3 : 0;
  } finally {
    closeTerminal();
    s.close();
  }
}

async function runScenarioCommand(args: Args, say: (l: string) => void): Promise<number> {
  const scenario = loadScenario(args.scenario!);
  const modes = args.mode ? [args.mode] : scenario.modes;
  const results = [];
  for (const mode of modes) {
    say(`== scenario ${scenario.name} — approval: ${mode}`);
    say(scenario.description);
    const run = await runScenario(scenario, { mode, say: args.json ? () => undefined : say });
    const check = checkScenario(scenario, run);
    for (const reply of run.replies) say(`agente: ${reply}`);
    say(check.ok ? `== ok — bundle em ${relative(process.cwd(), run.bundle_dir)}` : `== FAIL: ${check.failures.join("; ")}`);
    results.push({ mode, ok: check.ok, failures: check.failures, run });
  }
  if (args.json) stdout.write(JSON.stringify({ scenario: scenario.name, results }) + "\n");
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    });
}
