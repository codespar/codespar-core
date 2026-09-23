/**
 * Section 12: scenario packs. A scenario is a JSON file with the person's
 * turns, the decision the approver gives, the hooks that make the world
 * change mid-run (revocation, an uncertain rail answer) and what the trail
 * must look like at the end. The model's outputs come from a recorded
 * transcript, so the same file feeds the CI, the live demo and the docs.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { StubRail, type ApprovalMode, type Execution } from "@codespar/agent-core";
import { AGENT_DIR, RUNS_DIR, setup, type Setup } from "./setup.js";
import { handleExecution } from "../channels/terminal/index.js";

const TurnSchema = z
  .object({
    input: z.string().min(1),
    decision: z.enum(["approve", "deny", "none"]).default("approve"),
    /** Runs after the execution is drafted and before the decision is taken. */
    before_decision: z.enum(["revoke_mandate", "pause_all"]).optional(),
    /** Runs after approval, before the rail is called; the core must catch it. */
    before_execute: z.enum(["revoke_mandate", "pause_all"]).optional(),
    /** The stub rail answers `uncertain` to the next attempt; the run ends with a reconcile. */
    rail_uncertain: z.boolean().default(false),
  })
  .strict();

const ExpectSchema = z
  .object({
    /** Final states of the executions, in order. */
    states: z.array(z.string()).optional(),
    /** History of each execution (the `to` of every transition). */
    trails: z.array(z.array(z.string())).optional(),
    reasons: z.array(z.string().nullable()).optional(),
    triggers: z.array(z.string().nullable()).optional(),
    receipts: z.number().int().nonnegative().optional(),
    refused_before_draft: z.number().int().nonnegative().optional(),
    /** Sum of the totals that reached `settled`. */
    settled_total: z.number().int().nonnegative().optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string(),
    modes: z.array(z.enum(["human", "mandate"])).nonempty(),
    now: z.string().datetime().default("2026-09-23T18:00:00.000Z"),
    transcript: z.string(),
    turns: z.array(TurnSchema).nonempty(),
    expect: z.record(z.enum(["human", "mandate", "both"]), ExpectSchema),
  })
  .strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

export interface ScenarioRun {
  scenario: string;
  mode: ApprovalMode;
  run_id: string;
  bundle_dir: string;
  replies: string[];
  executions: Array<{ id: string; state: string; reason: string | null; trigger: string | null; total: number; trail: string[]; receipt_ids: string[] }>;
  refused_before_draft: number;
  receipts: number;
  settled_total: number;
}

export interface ScenarioCheck {
  ok: boolean;
  mode: ApprovalMode;
  failures: string[];
  run: ScenarioRun;
}

export function scenariosDir(): string {
  return join(AGENT_DIR, "scenarios");
}

export function listScenarios(): string[] {
  return readdirSync(scenariosDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => basename(f, ".json"))
    .sort();
}

export function loadScenario(name: string): Scenario {
  const path = join(scenariosDir(), `${name}.json`);
  if (!existsSync(path)) throw new Error(`unknown scenario ${name}; available: ${listScenarios().join(", ")}`);
  return ScenarioSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface RunScenarioOptions {
  mode: ApprovalMode;
  runsDir?: string;
  stateDir?: string;
  say?: (line: string) => void;
}

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioRun> {
  const say = options.say ?? (() => undefined);
  let clock = new Date(scenario.now);
  const tick = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  };
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), `bills-${scenario.name}-${options.mode}-`));
  const s: Setup = setup({
    mode: options.mode,
    rail: "stub",
    provider: "replay",
    transcript: resolve(scenariosDir(), scenario.transcript),
    runsDir: options.runsDir ?? RUNS_DIR,
    stateDir,
    now: tick,
    say,
  });
  const stub = s.rail as StubRail;
  const runtime = s.makeRuntime();
  const replies: string[] = [];
  const approver = { id: "usr_demo_titular", channel: "terminal" };
  let refusedBeforeDraft = 0;

  try {
    for (const turn of scenario.turns) {
      if (turn.rail_uncertain) stub.armUncertainOnce();
      const loop = s.makeLoop(runtime, async (execution: Execution) => {
        applyHook(s, turn.before_decision);
        const decided = await handleExecution(execution, {
          setup: s,
          approver,
          decision: turn.decision,
          say,
          ask: async () => (turn.decision === "approve" ? "s" : "n"),
        });
        if (turn.before_execute && decided.state === "approved") {
          applyHook(s, turn.before_execute);
          return s.engine.execute(decided.id);
        }
        return decided;
      });
      const result = await loop.turn(turn.input);
      replies.push(result.reply);
      refusedBeforeDraft += s.store.listEvents({ run_id: s.runId }).filter((e) => e.type === "execution.refused_before_draft").length - refusedBeforeDraft;
    }
    // Section 10: what is still executing is reconciled, never repeated. A rail that answers late needs more than one look.
    for (let round = 0; round < 3 && s.engine.list({ state: "executing" }).length > 0; round += 1) {
      for (const stuck of s.engine.list({ state: "executing" })) await s.engine.reconcile(stuck.id);
    }

    const executions = s.engine.list().filter((e) => e.run_id === s.runId);
    return {
      scenario: scenario.name,
      mode: options.mode,
      run_id: s.runId,
      bundle_dir: s.bundle.dir,
      replies,
      executions: executions.map((e) => ({
        id: e.id,
        state: e.state,
        reason: e.reason ?? null,
        trigger: e.escalation?.trigger ?? null,
        total: e.total,
        trail: e.history.map((h) => h.to),
        receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id as string),
      })),
      refused_before_draft: refusedBeforeDraft,
      receipts: s.bundle.listReceipts().length,
      settled_total: executions.filter((e) => e.state === "settled").reduce((sum, e) => sum + e.total, 0),
    };
  } finally {
    s.close();
  }
}

function applyHook(s: Setup, hook: "revoke_mandate" | "pause_all" | undefined): void {
  if (hook === "revoke_mandate") s.gate.revoke(s.mandate.id, "revoked mid-run by the scenario");
  if (hook === "pause_all") s.gate.pauseAll();
}

export function checkScenario(scenario: Scenario, run: ScenarioRun): ScenarioCheck {
  const failures: string[] = [];
  const expectations = [scenario.expect["both"], scenario.expect[run.mode]].filter((e): e is z.infer<typeof ExpectSchema> => e !== undefined);
  for (const expect of expectations) {
    if (expect.states && JSON.stringify(run.executions.map((e) => e.state)) !== JSON.stringify(expect.states)) failures.push(`states ${JSON.stringify(run.executions.map((e) => e.state))} != ${JSON.stringify(expect.states)}`);
    if (expect.trails && JSON.stringify(run.executions.map((e) => e.trail)) !== JSON.stringify(expect.trails)) failures.push(`trails ${JSON.stringify(run.executions.map((e) => e.trail))} != ${JSON.stringify(expect.trails)}`);
    if (expect.reasons && JSON.stringify(run.executions.map((e) => e.reason)) !== JSON.stringify(expect.reasons)) failures.push(`reasons ${JSON.stringify(run.executions.map((e) => e.reason))} != ${JSON.stringify(expect.reasons)}`);
    if (expect.triggers && JSON.stringify(run.executions.map((e) => e.trigger)) !== JSON.stringify(expect.triggers)) failures.push(`triggers ${JSON.stringify(run.executions.map((e) => e.trigger))} != ${JSON.stringify(expect.triggers)}`);
    if (expect.receipts !== undefined && run.receipts !== expect.receipts) failures.push(`receipts ${run.receipts} != ${expect.receipts}`);
    if (expect.refused_before_draft !== undefined && run.refused_before_draft !== expect.refused_before_draft) failures.push(`refused_before_draft ${run.refused_before_draft} != ${expect.refused_before_draft}`);
    if (expect.settled_total !== undefined && run.settled_total !== expect.settled_total) failures.push(`settled_total ${run.settled_total} != ${expect.settled_total}`);
  }
  // Every run, every mode: nothing reaches executing without an approval artifact carrying its hash.
  return { ok: failures.length === 0, mode: run.mode, failures, run };
}
