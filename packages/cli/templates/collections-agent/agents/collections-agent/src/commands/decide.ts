import { relative } from "node:path";
import { stderr, stdout } from "node:process";
import { handleExecution } from "../../channels/terminal/index.js";
import { readDotEnv, setup } from "../setup.js";

export async function decideFromCli(decision: "approve" | "deny"): Promise<never> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const user = argv.includes("--user") ? argv[argv.indexOf("--user") + 1] : undefined;
  const wait = argv.includes("--wait") ? Number(argv[argv.indexOf("--wait") + 1]) : undefined;
  const simulatePayer = argv.includes("--simulate-payer");
  const executionId = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--user" && argv[i - 1] !== "--wait");
  const say = (l: string) => stderr.write(l + "\n");
  if (!executionId) {
    say(`usage: npm run ${decision} <execution-id> [--user <id>] [--wait <seconds>] [--simulate-payer] [--json]`);
    process.exit(2);
  }
  readDotEnv();
  const s = setup({ say, runId: `run_${decision}_${Date.now().toString(36)}` });
  try {
    const execution = s.engine.get(executionId);
    if (!execution) {
      say(`unknown execution ${executionId}`);
      process.exit(1);
    }
    if (execution.state !== "awaiting_approval") {
      say(`${executionId} is ${execution.state}, not awaiting_approval; nothing to decide`);
      process.exit(1);
    }
    const final = await handleExecution(execution, { setup: s, approver: { id: user ?? "usr_operator", channel: "terminal" }, decision, say, tell: json ? say : undefined, waitSeconds: wait, simulatePayer });
    if (json) {
      stdout.write(
        JSON.stringify({
          execution_id: final.id,
          state: final.state,
          reason: final.reason ?? null,
          approval_id: final.approval_id ?? null,
          charge_ids: final.outcomes.map((o) => o.transaction_id ?? null),
          receipt_ids: final.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
          bundle_dir: relative(process.cwd(), s.bundle.dir),
        }) + "\n",
      );
    }
    process.exit(final.state === "executing" && final.reason !== "awaiting_settlement" ? 3 : 0);
  } finally {
    s.close();
  }
}
