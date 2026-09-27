/**
 * `codespar-agent reconcile [--json]`: compares local state with the rail.
 * Names executions without an outcome, attempts the rail never saw, sealed
 * outcomes the rail holds that the bundle does not. Read-only unless an
 * execution is in `executing`, which it closes from what the rail says.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import type { Agent } from "../agent.js";
import { runsDir, setup } from "../setup.js";

export async function reconcile(agent: Agent, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const awaitsPayer = agent.settlement === "await-payer";
  const say = (l: string) => stderr.write(l + "\n");
  const s = setup(agent, { say, runId: `run_reconcile_${Date.now().toString(36)}` });
  try {
    const findings: Array<{ execution_id: string; kind: string; detail: string }> = [];
    for (const e of s.engine.list()) {
      if (e.state === "executing") {
        const closed = await s.engine.reconcile(e.id);
        const kind = closed.state === "executing" ? (awaitsPayer && closed.reason === "awaiting_settlement" ? "awaiting_payer" : "still_uncertain") : "closed_from_rail";
        findings.push({ execution_id: e.id, kind, detail: `executing -> ${closed.state}${awaitsPayer && closed.detail ? ` (${closed.detail})` : ""}` });
        continue;
      }
      for (const o of e.outcomes) {
        if (o.receipt_id && !existsSync(join(runsDir(agent), e.run_id, "receipts", `${o.receipt_id}.json`))) {
          findings.push({ execution_id: e.id, kind: s.kit.labels.missingReceiptKind, detail: s.kit.labels.missingReceiptDetail(o.receipt_id, e.run_id) });
        }
      }
      const outbox = s.store.getOutbox(e.idempotency_key);
      if (e.state === "settled" && outbox?.status !== "done") findings.push({ execution_id: e.id, kind: "outbox_mismatch", detail: `settled but outbox is ${outbox?.status ?? "absent"}` });
    }
    for (const f of findings) say(`${f.kind} ${f.execution_id}: ${f.detail}`);
    if (json) stdout.write(JSON.stringify({ executions: s.engine.list().length, findings }) + "\n");
    else say(findings.length ? `${findings.length} finding(s)` : "local state and rail agree");
    return 0;
  } finally {
    s.close();
  }
}
