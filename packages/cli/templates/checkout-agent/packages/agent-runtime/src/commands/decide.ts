/**
 * `codespar-agent approve|deny <execution-id> [--user <id>] [--json]`:
 * decides an execution left in `awaiting_approval` (a `--input` run without
 * `--approve`, a restart). Produces the section 4.2 artifact and runs the
 * execution through the same last gate `start` uses.
 */
import { relative } from "node:path";
import { stderr, stdout } from "node:process";
import type { Agent } from "../agent.js";
import { setup } from "../setup.js";
import { handleExecution } from "../terminal.js";

export async function decide(agent: Agent, decision: "approve" | "deny", argv: string[]): Promise<number> {
  const awaitsPayer = agent.settlement === "await-payer";
  const json = argv.includes("--json");
  const user = argv.includes("--user") ? argv[argv.indexOf("--user") + 1] : undefined;
  const wait = awaitsPayer && argv.includes("--wait") ? Number(argv[argv.indexOf("--wait") + 1]) : undefined;
  const simulatePayer = awaitsPayer && argv.includes("--simulate-payer");
  const executionId = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--user" && (!awaitsPayer || argv[i - 1] !== "--wait"));
  const say = (l: string) => stderr.write(l + "\n");
  if (!executionId) {
    say(`usage: npm run ${decision} <execution-id> [--user <id>]${awaitsPayer ? " [--wait <seconds>] [--simulate-payer]" : ""} [--json]`);
    return 2;
  }
  const s = setup(agent, { say, runId: `run_${decision}_${Date.now().toString(36)}` });
  try {
    const execution = s.engine.get(executionId);
    if (!execution) {
      say(`unknown execution ${executionId}`);
      return 1;
    }
    if (execution.state !== "awaiting_approval") {
      say(`${executionId} is ${execution.state}, not awaiting_approval; nothing to decide`);
      return 1;
    }
    const final = await handleExecution(execution, {
      setup: s,
      approver: { id: user ?? s.kit.labels.defaultUser, channel: "terminal" },
      decision,
      say,
      ...(json ? { tell: say } : {}),
      waitSeconds: wait,
      simulatePayer,
    });
    if (json) {
      stdout.write(
        JSON.stringify({
          execution_id: final.id,
          state: final.state,
          reason: final.reason ?? null,
          approval_id: final.approval_id ?? null,
          ...(awaitsPayer ? { charge_ids: final.outcomes.map((o) => o.transaction_id ?? null) } : {}),
          receipt_ids: final.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
          bundle_dir: relative(process.cwd(), s.bundle.dir),
        }) + "\n",
      );
    }
    if (awaitsPayer) return final.state === "executing" && final.reason !== "awaiting_settlement" ? 3 : 0;
    return final.state === "executing" ? 3 : 0;
  } finally {
    s.close();
  }
}
