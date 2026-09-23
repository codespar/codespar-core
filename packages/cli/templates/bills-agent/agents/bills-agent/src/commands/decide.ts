import { relative } from "node:path";
import { stderr, stdout } from "node:process";
import { handleExecution } from "../../channels/terminal/index.js";
import { readDotEnv, setup } from "../setup.js";

export async function decideFromCli(decision: "approve" | "deny"): Promise<never> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const user = argv.includes("--user") ? argv[argv.indexOf("--user") + 1] : undefined;
  const executionId = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--user");
  const say = (l: string) => stderr.write(l + "\n");
  if (!executionId) {
    say(`usage: npm run ${decision} <execution-id> [--user <id>] [--json]`);
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
    const final = await handleExecution(execution, { setup: s, approver: { id: user ?? "usr_terminal", channel: "terminal" }, decision, say });
    if (json) {
      stdout.write(
        JSON.stringify({
          execution_id: final.id,
          state: final.state,
          reason: final.reason ?? null,
          approval_id: final.approval_id ?? null,
          receipt_ids: final.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
          bundle_dir: relative(process.cwd(), s.bundle.dir),
        }) + "\n",
      );
    }
    process.exit(final.state === "executing" ? 3 : 0);
  } finally {
    s.close();
  }
}
