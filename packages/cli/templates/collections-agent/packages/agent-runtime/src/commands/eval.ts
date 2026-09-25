/**
 * `codespar-agent eval [--json] [--case <name>]`: the adversarial suite of
 * section 9 plus every scenario of section 12 in every mode it declares. Runs
 * on the replay provider and the stub rail, with no model and no network. A
 * regression blocks merge.
 */
import { stderr, stdout } from "node:process";
import type { Agent } from "../agent.js";
import { listAdversarialCases, loadAdversarialCase, runAdversarialCase, type AdversarialResult } from "../adversarial.js";
import { checkScenario, listScenarios, loadScenario, runScenario, type ScenarioCheck } from "../scenarios.js";

export async function runEval(agent: Agent, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const only = argv.includes("--case") ? argv[argv.indexOf("--case") + 1] : undefined;
  const say = (l: string) => stderr.write(l + "\n");
  const awaitsPayer = agent.settlement === "await-payer";

  const adversarial = [];
  for (const name of listAdversarialCases(agent)) {
    if (only && only !== name) continue;
    const result = await runAdversarialCase(agent, loadAdversarialCase(agent, name));
    adversarial.push(result);
    say(agent.kit.evalAdversarialLine?.(result) ?? adversarialLine(result));
  }

  const scenarios = [];
  for (const name of listScenarios(agent)) {
    if (only && only !== name) continue;
    const scenario = loadScenario(agent, name);
    if (!scenario.rails.includes("stub")) continue;
    for (const mode of scenario.modes) {
      const check = checkScenario(scenario, await runScenario(agent, scenario, { mode, rail: "stub" }));
      scenarios.push({
        name,
        mode,
        ok: check.ok,
        failures: check.failures,
        states: check.run.executions.map((e) => e.state),
        receipts: check.run.receipts,
        ...(awaitsPayer ? { charges_issued: check.run.charges_issued, debtor_messages: check.run.debtor_messages } : {}),
      });
      say(agent.kit.evalScenarioLine?.(check) ?? scenarioLine(check));
    }
  }

  const ok = adversarial.every((r) => r.ok) && scenarios.every((r) => r.ok);
  if (json) stdout.write(JSON.stringify({ ok, adversarial, scenarios }) + "\n");
  say(ok ? `eval ok: ${adversarial.length} adversarial case(s), ${scenarios.length} scenario run(s)` : "eval FAILED");
  return ok ? 0 : 1;
}

function adversarialLine(result: AdversarialResult): string {
  return `${result.ok ? "ok  " : "FAIL"} adversarial/${result.name} — ${result.attack} — states ${JSON.stringify(result.states)}${result.failures.length ? ` — ${result.failures.join("; ")}` : ""}`;
}

function scenarioLine(check: ScenarioCheck): string {
  return `${check.ok ? "ok  " : "FAIL"} scenario/${check.run.scenario} [${check.mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.receipts} receipt(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`;
}
