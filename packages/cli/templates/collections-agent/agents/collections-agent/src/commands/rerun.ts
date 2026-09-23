/**
 * `npm run rerun <run-id> [--json]`: replays a recorded run against the
 * deterministic provider and the stub rail, with no network, in a fresh
 * state, and compares the sequence of states with the original bundle. The
 * model's outputs are the recording; the payer's behaviour is read from the
 * recorded outcomes (paid, expired); every decision of the core is recomputed.
 */
import { mkdtempSync } from "node:fs";
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
const events = original.readEvents();
const originalTrail = events.filter((e) => e["type"] === "execution.transition").map((e) => (e["payload"] as { to: string }).to);
const originalDecisions = events.filter((e) => e["type"] === "approval.created").map((e) => ((e["payload"] as { approver: { type: string } }).approver.type === "person" ? "approve" : "mandate"));
const userTurns = original.readTranscript().filter((l) => l.kind === "user").map((l) => l["text"] as string);
// The payer's behaviour is part of the recording: a receivable that expired in the original run expires in the rerun.
const expired = events.some((e) => e["type"] === "execution.transition" && (e["payload"] as { reason?: string }).reason === "charge_expired");
const transcriptPath = join(original.dir, "transcript.jsonl");

const s = setup({ mode, rail: "stub", provider: "replay", transcript: transcriptPath, runId: `${runId}_rerun_${Date.now().toString(36)}`, stateDir: mkdtempSync(join(tmpdir(), "collections-rerun-")), stubRail: { payer: expired ? "expires" : "pays" }, say });
try {
  let decisionIndex = 0;
  const runtime = s.makeRuntime();
  const loop = s.makeLoop(runtime, (execution: Execution) => {
    const decision = execution.state === "awaiting_approval" ? (originalDecisions[decisionIndex++] === "approve" ? "approve" : "deny") : "none";
    return handleExecution(execution, { setup: s, approver: { id: "usr_rerun", channel: "terminal" }, decision, say, tell: () => undefined, simulatePayer: !expired });
  });
  for (const text of userTurns) await loop.turn(text);
  const trail = s.store.listEvents({ run_id: s.runId }).filter((e) => e.type === "execution.transition").map((e) => (e.payload as { to: string }).to);
  const same = JSON.stringify(trail) === JSON.stringify(originalTrail);
  if (json) stdout.write(JSON.stringify({ run_id: runId, rerun_id: s.runId, same_states: same, original: originalTrail, rerun: trail, bundle_dir: s.bundle.dir }) + "\n");
  say(same ? `rerun ok: ${trail.length} transition(s), same sequence as ${runId}` : `rerun DIFFERS: original ${JSON.stringify(originalTrail)} vs rerun ${JSON.stringify(trail)}`);
  process.exit(same ? 0 : 1);
} finally {
  s.close();
}
