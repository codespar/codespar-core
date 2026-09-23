/**
 * `npm run rerun <run-id> [--json]`: replays a recorded run against the
 * deterministic provider, with no network, in a fresh state, and compares
 * the sequence of states with the original bundle. The model's outputs are
 * the recording; every decision of the core is recomputed.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stderr, stdout } from "node:process";
import { ProofBundle, type ApprovalMode, type Execution } from "@codespar/agent-core";
import { handleExecution } from "../../channels/terminal/index.js";
import { runsDir, setup } from "../setup.js";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const runId = argv.find((a) => !a.startsWith("--"));
const say = (l: string) => stderr.write(l + "\n");
if (!runId) {
  say("usage: npm run rerun <run-id> [--json]");
  process.exit(2);
}
const original = ProofBundle.open(runsDir(), runId);
if (!original) {
  say(`no bundle at runs/${runId}`);
  process.exit(1);
}
const meta = original.readMeta() ?? {};
const mode = (meta["mode"] as ApprovalMode | undefined) ?? "human";
const originalTrail = original
  .readEvents()
  .filter((e) => e["type"] === "execution.transition")
  .map((e) => (e["payload"] as { to: string }).to);
const originalDecisions = original.readEvents().filter((e) => e["type"] === "approval.created").map((e) => ((e["payload"] as { approver: { type: string } }).approver.type === "person" ? "approve" : "mandate"));
const userTurns = original.readTranscript().filter((l) => l.kind === "user").map((l) => l["text"] as string);
// The rail's answers are part of the recording: a payee the rail refused in the original run is refused in the rerun.
const events = original.readEvents();
const dispatched = new Map(events.filter((e) => e["type"] === "rail.dispatch").map((e) => [(e["payload"] as { attempt_id: string }).attempt_id, (e["payload"] as { payee: string }).payee]));
const refusedPayees = events
  .filter((e) => e["type"] === "rail.outcome" && (e["payload"] as { status: string }).status === "failed")
  .map((e) => dispatched.get((e["payload"] as { attempt_id: string }).attempt_id))
  .filter((p): p is string => typeof p === "string");
const transcriptPath = join(original.dir, "transcript.jsonl");
readFileSync(transcriptPath, "utf8");

const s = setup({ mode, rail: "stub", provider: "replay", transcript: transcriptPath, runId: `${runId}_rerun_${Date.now().toString(36)}`, stateDir: mkdtempSync(join(tmpdir(), "bills-rerun-")), stubRail: { refusePayees: refusedPayees }, say });
try {
  let decisionIndex = 0;
  const runtime = s.makeRuntime();
  const loop = s.makeLoop(runtime, (execution: Execution) => {
    const decision = execution.state === "awaiting_approval" ? (originalDecisions[decisionIndex++] === "approve" ? "approve" : "deny") : "none";
    return handleExecution(execution, { setup: s, approver: { id: "usr_rerun", channel: "terminal" }, decision, say });
  });
  for (const text of userTurns) await loop.turn(text);
  const trail = s.store.listEvents({ run_id: s.runId }).filter((e) => e.type === "execution.transition").map((e) => (e.payload as { to: string }).to);
  const outcomesOf = (list: Record<string, unknown>[]) => list.filter((e) => e["type"] === "rail.outcome").map((e) => (e["payload"] as { status: string }).status);
  const originalOutcomes = outcomesOf(events);
  const rerunOutcomes = outcomesOf(s.bundle.readEvents());
  const same = JSON.stringify(trail) === JSON.stringify(originalTrail) && JSON.stringify(rerunOutcomes) === JSON.stringify(originalOutcomes);
  if (json) stdout.write(JSON.stringify({ run_id: runId, rerun_id: s.runId, same_states: same, original: originalTrail, rerun: trail, original_outcomes: originalOutcomes, rerun_outcomes: rerunOutcomes, bundle_dir: s.bundle.dir }) + "\n");
  say(same ? `rerun ok: ${trail.length} transition(s), same sequence as ${runId}` : `rerun DIFFERS: original ${JSON.stringify(originalTrail)} vs rerun ${JSON.stringify(trail)}`);
  process.exit(same ? 0 : 1);
} finally {
  s.close();
}
