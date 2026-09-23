/**
 * `npm start`                                                  interactive terminal (you are the payer)
 * `npm start -- --input "oi, recebi a mensagem do acordo 1042"`  one turn, no prompt
 * `npm start -- --scenario happy-path`                         a scenario pack, both modes it declares
 *
 * `--json` puts machine data on stdout (valid JSON, nothing else) and the
 * human messages on stderr.
 */
import { stderr, stdout } from "node:process";
import { relative, resolve } from "node:path";
import { NotATestKeyError, isTestKey } from "@codespar/agent-core";
import { closeTerminal, handleExecution, interactive } from "../channels/terminal/index.js";
import { checkScenario, listScenarios, loadScenario, runScenario, scenariosDir } from "./scenarios.js";
import { readDotEnv, resolveRailKind, setup, type RailKind } from "./setup.js";

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
  wait?: number;
  simulatePayer: boolean;
  payer?: "pays" | "expires" | "never";
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, user: "usr_operator", simulatePayer: false, help: false };
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
    else if (a === "--wait") {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0) throw new Error("--wait must be a number of seconds");
      args.wait = v;
    } else if (a === "--simulate-payer") args.simulatePayer = true;
    else if (a === "--payer") {
      const v = next();
      if (v !== "pays" && v !== "expires" && v !== "never") throw new Error("--payer must be pays, expires or never");
      args.payer = v;
    } else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const USAGE = `collections-agent
  npm start                                                    interactive terminal (you are the payer)
  npm start -- --input "oi, recebi a mensagem do acordo 1042"    one turn (add --approve/--deny to decide, --json for machine output)
  npm start -- --scenario <name>                               run a scenario pack (see scenarios/)
options: --mode human|mandate  --provider anthropic|replay  --transcript <file>  --rail stub|api  --user <id>
         --wait <seconds>  --simulate-payer  --payer pays|expires|never (stub only)  --json`;

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

  // Sandbox by construction: a live key dies here, before anything else runs.
  const railKind = resolveRailKind(process.env, args.rail);
  if (railKind === "api" && !isTestKey(process.env["CODESPAR_API_KEY"])) {
    say(new NotATestKeyError().message);
    return 1;
  }

  if (args.scenario) return runScenarioCommand(args, railKind, say);

  // One-shot without a model: replay the recorded scenario whose first turn is this input.
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
  if (args.payer) s.payer.behave(args.payer);
  const approver = { id: args.user, channel: "terminal" };
  const started = Date.now();
  try {
    const runtime = s.makeRuntime();
    if (!args.input) {
      await interactive({ setup: s, approver, runtime, say, waitSeconds: args.wait, simulatePayer: args.simulatePayer });
      return 0;
    }
    const loop = s.makeLoop(runtime, (execution) => handleExecution(execution, { setup: s, approver, decision: args.decision ?? "none", say, waitSeconds: args.wait, simulatePayer: args.simulatePayer, tell: args.json ? say : undefined }));
    const result = await loop.turn(args.input);
    const executions = s.engine.list().filter((e) => e.run_id === s.runId);
    const payload = {
      run_id: s.runId,
      agent: `${s.manifest.manifest.name}@${s.manifest.manifest.version}`,
      mode: s.mode,
      rail: s.railKind,
      policy_id: s.mandate.id,
      actor: s.engine.agentActor,
      reply: result.reply,
      tool_calls: result.tool_calls,
      executions: executions.map((e) => ({
        id: e.id,
        state: e.state,
        reason: e.reason ?? null,
        escalation: e.escalation ?? null,
        total_minor: e.total,
        items: e.items.map((i) => ({ debtor: i.beneficiary, amount_minor: i.amount, due_date: i.due_date ?? null })),
        approval_id: e.approval_id ?? null,
        charges: e.outcomes.map((o) => ({ instalment: o.index + 1, charge_id: o.transaction_id ?? null, status: o.status, code: o.code ?? null, payable: o.instrument?.payable ?? null, pix_copy_paste: o.instrument?.pix_copy_paste ?? null })),
        receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
      })),
      receipts: s.bundle.listReceipts().map((f) => relative(process.cwd(), `${s.bundle.dir}/receipts/${f}`)),
      bundle_dir: relative(process.cwd(), s.bundle.dir),
      seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10,
    };
    if (args.json) stdout.write(JSON.stringify(payload) + "\n");
    else stdout.write(result.reply + "\n");
    return executions.some((e) => e.state === "executing") ? 3 : 0;
  } finally {
    closeTerminal();
    s.close();
  }
}

async function runScenarioCommand(args: Args, railKind: RailKind, say: (l: string) => void): Promise<number> {
  const scenario = loadScenario(args.scenario!);
  if (!scenario.rails.includes(railKind)) {
    say(`scenario ${scenario.name} runs on ${scenario.rails.join("/")} only (asked: ${railKind})`);
    return 2;
  }
  const modes = args.mode ? [args.mode] : scenario.modes;
  const results = [];
  for (const mode of modes) {
    say(`== scenario ${scenario.name} — approval: ${mode} — rail: ${railKind}`);
    say(scenario.description);
    const run = await runScenario(scenario, { mode, rail: railKind, say: args.json ? () => undefined : say, tell: args.json ? () => undefined : (l) => stdout.write(l + "\n"), waitSeconds: args.wait });
    const check = checkScenario(scenario, run);
    for (const reply of run.replies) say(`agente: ${reply}`);
    say(check.ok ? `== ok — ${run.cycle_seconds}s — bundle em ${relative(process.cwd(), run.bundle_dir)}` : `== FAIL: ${check.failures.join("; ")}`);
    results.push({ mode, ok: check.ok, failures: check.failures, run });
  }
  if (args.json) stdout.write(JSON.stringify({ scenario: scenario.name, rail: railKind, results }) + "\n");
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
