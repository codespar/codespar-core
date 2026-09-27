/**
 * `codespar-agent resume [--json]`: after a crash or a restart. Executions
 * left in `executing` are reconciled against the rail, never repeated: a
 * lookup presents the same explicit attempt_id, which the API answers from
 * its record of that attempt without paying again (ent#1671). Stale open
 * ones expire.
 */
import { stderr, stdout } from "node:process";
import type { Execution } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import { setup } from "../setup.js";
import { followUp } from "../terminal.js";

export async function resume(agent: Agent, argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const awaitsPayer = agent.settlement === "await-payer";
  const say = (l: string) => stderr.write(l + "\n");
  const s = setup(agent, { say, runId: `run_resume_${Date.now().toString(36)}` });
  try {
    const closed: Execution[] = [];
    // Only resume dispatches, and only what the outbox proves was never sent; everything else is reconciled from the rail.
    for (const stuck of s.engine.list({ state: "executing" })) {
      const e = await s.engine.resumePending(stuck.id);
      closed.push(e);
      say(e.state === "executing" ? s.kit.labels.stillExecuting(e) : `${e.id}: executing -> ${e.state}`);
    }
    for (const e of closed) if (e.state !== "executing") await followUp(e, s, say);
    // What a crash left half-done after an outcome (a service invoice opened and never sent, or sent and never answered).
    await s.kit.resumeFollowUps?.(s, say);
    const expired = s.engine.expireStale().map((e) => ({ id: e.id, state: e.state }));
    for (const e of expired) say(`${e.id}: -> expired`);
    const open = s.engine.list({ state: ["awaiting_approval", "approved"] }).map((e) => ({ id: e.id, state: e.state }));
    for (const e of open) say(`${e.id}: still ${e.state}; decide it with npm run approve ${e.id} / npm run deny ${e.id}`);
    if (json) {
      const resumed = closed.map((e) => ({
        id: e.id,
        state: e.state,
        ...(awaitsPayer ? { reason: e.reason ?? null } : {}),
        detail: e.detail ?? null,
        ...(awaitsPayer ? { charge_ids: e.outcomes.map((o) => o.transaction_id ?? null) } : {}),
        receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id),
      }));
      stdout.write(JSON.stringify({ resumed, expired, open, bundle_dir: s.bundle.dir }) + "\n");
    } else say(closed.length || expired.length ? "resume done" : "nothing to resume");
    return closed.some((e) => e.state === "executing" && (!awaitsPayer || e.reason !== "awaiting_settlement")) ? 3 : 0;
  } finally {
    s.close();
  }
}
