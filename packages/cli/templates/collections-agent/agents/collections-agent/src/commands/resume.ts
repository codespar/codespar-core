/**
 * `npm run resume [--json]`: after a crash or a restart. Executions left in
 * `executing` are reconciled against the rail (idempotent on attempt_id),
 * never repeated: a receivable already issued is looked at, not re-issued;
 * one whose outbox is still pending goes out once. Stale open ones expire.
 */
import { stderr, stdout } from "node:process";
import { readDotEnv, setup } from "../setup.js";

const json = process.argv.includes("--json");
const say = (l: string) => stderr.write(l + "\n");
readDotEnv();
const s = setup({ say, runId: `run_resume_${Date.now().toString(36)}` });
try {
  const resumed = [];
  for (const stuck of s.engine.list({ state: "executing" })) {
    const closed = await s.engine.resumePending(stuck.id);
    resumed.push({ id: closed.id, state: closed.state, reason: closed.reason ?? null, detail: closed.detail ?? null, charge_ids: closed.outcomes.map((o) => o.transaction_id ?? null), receipt_ids: closed.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id) });
    say(closed.state === "executing" ? `${closed.id}: still executing (${closed.reason}) — ${closed.detail}; nothing was re-issued; \`npm run poll\` keeps looking` : `${closed.id}: executing -> ${closed.state}`);
  }
  const expired = s.engine.expireStale().map((e) => ({ id: e.id, state: e.state }));
  for (const e of expired) say(`${e.id}: -> expired`);
  const open = s.engine.list({ state: ["awaiting_approval", "approved"] }).map((e) => ({ id: e.id, state: e.state }));
  for (const e of open) say(`${e.id}: still ${e.state}; decide it with npm run approve ${e.id} / npm run deny ${e.id}`);
  if (json) stdout.write(JSON.stringify({ resumed, expired, open, bundle_dir: s.bundle.dir }) + "\n");
  else say(resumed.length || expired.length ? "resume done" : "nothing to resume");
  process.exit(resumed.some((r) => r.state === "executing" && r.reason !== "awaiting_settlement") ? 3 : 0);
} finally {
  s.close();
}
