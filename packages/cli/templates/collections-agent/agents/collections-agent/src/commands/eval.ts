/**
 * `npm run eval [--json] [--case <name>]`: the adversarial suite of section 9
 * plus every scenario of section 12 in every mode it declares. Runs on the
 * replay provider and the stub rail, with no model and no network. A
 * regression blocks merge.
 */
import { stderr, stdout } from "node:process";
import { listAdversarialCases, loadAdversarialCase, runAdversarialCase } from "../adversarial.js";
import { checkScenario, listScenarios, loadScenario, runScenario } from "../scenarios.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const only = argv.includes("--case") ? argv[argv.indexOf("--case") + 1] : undefined;
const say = (l: string) => stderr.write(l + "\n");

const adversarial = [];
for (const name of listAdversarialCases()) {
  if (only && only !== name) continue;
  const result = await runAdversarialCase(loadAdversarialCase(name));
  adversarial.push(result);
  say(`${result.ok ? "ok  " : "FAIL"} adversarial/${name} — ${result.attack} — states ${JSON.stringify(result.states)}${result.failures.length ? ` — ${result.failures.join("; ")}` : ""}`);
}

const scenarios = [];
for (const name of listScenarios()) {
  if (only && only !== name) continue;
  const scenario = loadScenario(name);
  if (!scenario.rails.includes("stub")) continue;
  for (const mode of scenario.modes) {
    const check = checkScenario(scenario, await runScenario(scenario, { mode, rail: "stub" }));
    scenarios.push({ name, mode, ok: check.ok, failures: check.failures, states: check.run.executions.map((e) => e.state), receipts: check.run.receipts, charges_issued: check.run.charges_issued, debtor_messages: check.run.debtor_messages });
    say(`${check.ok ? "ok  " : "FAIL"} scenario/${name} [${mode}] — states ${JSON.stringify(check.run.executions.map((e) => e.state))}, ${check.run.charges_issued} charge(s), ${check.run.receipts} record(s), ${check.run.debtor_messages} message(s)${check.failures.length ? ` — ${check.failures.join("; ")}` : ""}`);
  }
}

const ok = adversarial.every((r) => r.ok) && scenarios.every((r) => r.ok);
if (json) stdout.write(JSON.stringify({ ok, adversarial, scenarios }) + "\n");
say(ok ? `eval ok: ${adversarial.length} adversarial case(s), ${scenarios.length} scenario run(s)` : "eval FAILED");
process.exit(ok ? 0 : 1);
