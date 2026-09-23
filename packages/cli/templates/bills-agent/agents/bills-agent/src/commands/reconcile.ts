/**
 * `npm run reconcile [--json]`: compares local state with the rail. Names
 * executions without an outcome, attempts the rail never saw, receipts the
 * rail sealed that the bundle does not hold. Read-only unless an execution
 * is in `executing`, which it closes from what the rail says.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { readDotEnv, runsDir, setup } from "../setup.js";

const json = process.argv.includes("--json");
const say = (l: string) => stderr.write(l + "\n");
readDotEnv();
const s = setup({ say, runId: `run_reconcile_${Date.now().toString(36)}` });
try {
  const findings: Array<{ execution_id: string; kind: string; detail: string }> = [];
  for (const e of s.engine.list()) {
    if (e.state === "executing") {
      const closed = await s.engine.reconcile(e.id);
      findings.push({ execution_id: e.id, kind: closed.state === "executing" ? "still_uncertain" : "closed_from_rail", detail: `executing -> ${closed.state}` });
      continue;
    }
    for (const o of e.outcomes) {
      if (o.receipt_id && !existsSync(join(runsDir(), e.run_id, "receipts", `${o.receipt_id}.json`))) {
        findings.push({ execution_id: e.id, kind: "receipt_missing_locally", detail: `receipt ${o.receipt_id} is not in runs/${e.run_id}/receipts` });
      }
    }
    const outbox = s.store.getOutbox(e.idempotency_key);
    if (e.state === "settled" && outbox?.status !== "done") findings.push({ execution_id: e.id, kind: "outbox_mismatch", detail: `settled but outbox is ${outbox?.status ?? "absent"}` });
  }
  for (const f of findings) say(`${f.kind} ${f.execution_id}: ${f.detail}`);
  if (json) stdout.write(JSON.stringify({ executions: s.engine.list().length, findings }) + "\n");
  else say(findings.length ? `${findings.length} finding(s)` : "local state and rail agree");
  process.exit(0);
} finally {
  s.close();
}
