/**
 * `npm run poll [--wait <seconds>] [--simulate-payer] [--json]`: keeps
 * looking at every receivable still waiting for its payer until it closes
 * or the wait runs out. This is the loop-closer for a terminal that has no
 * webhook URL; `npm run webhook` is the other. Presents an instrument not yet
 * shown, tells the payer the outcome once, fetches the paid record.
 */
import { stderr, stdout } from "node:process";
import { announceOutcome, waitForPayer } from "../../channels/terminal/index.js";
import { readDotEnv, setup } from "../setup.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const wait = argv.includes("--wait") ? Number(argv[argv.indexOf("--wait") + 1]) : undefined;
const simulatePayer = argv.includes("--simulate-payer");
const say = (l: string) => stderr.write(l + "\n");
const tell = (l: string) => (json ? stderr : stdout).write(l + "\n");
readDotEnv();
const s = setup({ say, runId: `run_poll_${Date.now().toString(36)}` });
try {
  const results = [];
  for (const open of s.engine.list({ state: "executing" })) {
    if (open.reason !== "awaiting_settlement") continue;
    const r = await waitForPayer(open.id, { setup: s, approver: { id: "usr_operator", channel: "terminal" }, say, tell, waitSeconds: wait, simulatePayer });
    announceOutcome(r.execution, s, tell);
    if (r.execution.state !== "executing") await s.engine.collectReceipts(r.execution.id);
    results.push({ id: r.execution.id, state: r.execution.state, reason: r.execution.reason ?? null, rounds: r.rounds, seconds: r.seconds, timed_out: r.timed_out });
    say(`${r.execution.id}: ${r.execution.state}${r.execution.reason ? ` (${r.execution.reason})` : ""} after ${r.rounds} look(s), ${r.seconds}s`);
  }
  if (json) stdout.write(JSON.stringify({ polled: results }) + "\n");
  else if (!results.length) say("nothing waiting for a payer");
  process.exit(results.some((r) => r.timed_out) ? 3 : 0);
} finally {
  s.close();
}
