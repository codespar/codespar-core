/**
 * Section 12: scenario packs. A scenario is a JSON file with the payer's
 * turns, the decision the operator gives, what the payer does with the
 * receivable (pays, lets it expire, nothing), the hooks that make the world
 * change mid-run (revocation) and what the trail must look like at the end.
 * The model's outputs come from a recorded transcript, so the same file
 * feeds the CI, the live demo and the docs. On the stub rail the payer is the
 * fixture inside the rail; with a test key it is the sandbox pay route, and
 * `cycle_seconds` is the measured time from issuance to `settled`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { ApprovalMode, Execution } from "@codespar/agent-core";
import { AGENT_DIR, RUNS_DIR, setup, type RailKind, type Setup } from "./setup.js";
import { announceOutcome, handleExecution } from "../channels/terminal/index.js";

const TurnSchema = z
  .object({
    input: z.string().min(1),
    decision: z.enum(["approve", "deny", "none"]).default("approve"),
    /** What the payer does with the receivable(s) this turn issues: pays during the turn, pays only after the last turn (`late`), lets it expire (stub-only), or nothing. */
    payer: z.enum(["pays", "late", "expires", "never"]).default("pays"),
    /** Runs after the execution is drafted and before the decision is taken. */
    before_decision: z.enum(["revoke_mandate", "pause_all"]).optional(),
    /** Runs after approval, before the rail is called; the core must catch it. */
    before_execute: z.enum(["revoke_mandate", "pause_all"]).optional(),
    /** The stub issuer loses its answer to the create once; the run reconciles. */
    rail_uncertain: z.boolean().default(false),
  })
  .strict();

const ExpectSchema = z
  .object({
    states: z.array(z.string()).optional(),
    trails: z.array(z.array(z.string())).optional(),
    reasons: z.array(z.string().nullable()).optional(),
    triggers: z.array(z.string().nullable()).optional(),
    receipts: z.number().int().nonnegative().optional(),
    refused_before_draft: z.number().int().nonnegative().optional(),
    settled_total: z.number().int().nonnegative().optional(),
    /** Receivables the rail issued (one per instalment; a retry never adds one). */
    charges_issued: z.number().int().nonnegative().optional(),
    /** Messages the payer received about outcomes: one per outcome, never two. */
    debtor_messages: z.number().int().nonnegative().optional(),
    /** With a real key: the happy path closes inside this many seconds from issuance. */
    max_cycle_seconds: z.number().positive().optional(),
  })
  .strict();

export const ScenarioSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string(),
    modes: z.array(z.enum(["human", "mandate"])).nonempty(),
    /** Which rails can run it. `expires` needs the fixture; the API's payer only pays. */
    rails: z.array(z.enum(["stub", "api"])).nonempty().default(["stub", "api"]),
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
  rail: RailKind;
  run_id: string;
  bundle_dir: string;
  replies: string[];
  executions: Array<{ id: string; state: string; reason: string | null; trigger: string | null; total: number; trail: string[]; charge_ids: string[]; receipt_ids: string[] }>;
  refused_before_draft: number;
  receipts: number;
  settled_total: number;
  charges_issued: number;
  debtor_messages: number;
  /** Seconds from the first issuance to the last terminal state (wall clock on the API; the fake clock's ticks on the stub). */
  cycle_seconds: number;
  payer_calls: string[];
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
  rail?: RailKind;
  runsDir?: string;
  stateDir?: string;
  say?: (line: string) => void;
  tell?: (line: string) => void;
  waitSeconds?: number | undefined;
}

export async function runScenario(scenario: Scenario, options: RunScenarioOptions): Promise<ScenarioRun> {
  const say = options.say ?? (() => undefined);
  const tell = options.tell ?? (() => undefined);
  const rail = options.rail ?? "stub";
  // On the stub the clock is the scenario's and ticks a second per read; on the API it is the wall clock, so the cycle is measured for real.
  let clock = new Date(scenario.now);
  const tick = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  };
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), `collections-${scenario.name}-${options.mode}-`));
  const s: Setup = setup({
    mode: options.mode,
    rail,
    provider: "replay",
    transcript: resolve(scenariosDir(), scenario.transcript),
    runsDir: options.runsDir ?? RUNS_DIR,
    stateDir,
    ...(rail === "stub" ? { now: tick } : {}),
    say,
  });
  const runtime = s.makeRuntime();
  const replies: string[] = [];
  const approver = { id: "usr_operator", channel: "terminal" };
  let refusedBeforeDraft = 0;
  const payerCalls: string[] = [];
  const late: string[] = [];
  let firstIssued: number | undefined;
  let lastClosed: number | undefined;

  try {
    for (const turn of scenario.turns) {
      s.payer.behave(turn.payer === "late" ? "never" : turn.payer);
      const before = new Set(s.engine.list().map((e) => e.id));
      const loop = s.makeLoop(runtime, async (execution: Execution) => {
        applyHook(s, turn.before_decision);
        const decided = await handleExecution(execution, {
          setup: s,
          approver,
          decision: turn.decision,
          say,
          tell,
          ask: async () => (turn.decision === "approve" ? "s" : "n"),
          simulatePayer: turn.payer === "pays",
          waitSeconds: options.waitSeconds ?? (rail === "api" ? 60 : 0),
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
      if (turn.payer === "late") for (const e of s.engine.list({ state: "executing" })) if (!before.has(e.id)) late.push(e.id);
    }
    // A late payer pays after the conversation ended (the receivable was in flight while the world changed).
    for (const id of late) {
      for (const o of s.engine.get(id)?.outcomes ?? []) {
        if (o.status !== "accepted" || !o.transaction_id) continue;
        if (rail === "stub") await s.engine.reconcile(id); // the fixture registers the instrument on the first look
        const r = await s.payer.pay(o.transaction_id, o.attempt_id);
        s.engine.note("sandbox_payer", id, { charge_id: o.transaction_id, ok: r.ok, detail: r.detail });
      }
    }
    // Section 10: what is still executing is reconciled, never repeated. A payer that answers late needs more than one look.
    for (let round = 0; round < (rail === "api" ? 20 : 3) && s.engine.list({ state: "executing" }).length > 0; round += 1) {
      if (rail === "api" && round > 0) await new Promise((r) => setTimeout(r, s.pollIntervalMs));
      for (const stuck of s.engine.list({ state: "executing" })) await s.engine.reconcile(stuck.id);
    }
    // Whatever closed after the conversation is told to the payer once, as the poll or the webhook would.
    for (const e of s.engine.list()) if (e.run_id === s.runId) announceOutcome(e, s, tell);

    const events = s.store.listEvents({ run_id: s.runId });
    for (const e of events) {
      if (e.type === "rail.outcome" && (e.payload as { status: string }).status === "accepted" && firstIssued === undefined) firstIssued = new Date(e.at).getTime();
      if (e.type === "execution.transition" && ["settled", "failed"].includes((e.payload as { to: string }).to)) lastClosed = new Date(e.at).getTime();
      if (e.type === "sandbox_payer") payerCalls.push(String((e.payload as { detail: string }).detail));
    }
    const executions = s.engine.list().filter((e) => e.run_id === s.runId);
    return {
      scenario: scenario.name,
      mode: options.mode,
      rail,
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
        charge_ids: e.outcomes.map((o) => o.transaction_id).filter((x): x is string => typeof x === "string"),
        receipt_ids: e.outcomes.filter((o) => o.receipt_id).map((o) => o.receipt_id as string),
      })),
      refused_before_draft: refusedBeforeDraft,
      receipts: s.bundle.listReceipts().length,
      settled_total: executions.filter((e) => e.state === "settled").reduce((sum, e) => sum + e.total, 0),
      charges_issued: events.filter((e) => e.type === "rail.outcome" && (e.payload as { status: string }).status === "accepted").length,
      debtor_messages: events.filter((e) => e.type === "message.debtor").length,
      cycle_seconds: firstIssued !== undefined && lastClosed !== undefined ? Math.round(((lastClosed - firstIssued) / 1000) * 10) / 10 : 0,
      payer_calls: payerCalls,
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
    if (expect.charges_issued !== undefined && run.charges_issued !== expect.charges_issued) failures.push(`charges_issued ${run.charges_issued} != ${expect.charges_issued}`);
    if (expect.debtor_messages !== undefined && run.debtor_messages !== expect.debtor_messages) failures.push(`debtor_messages ${run.debtor_messages} != ${expect.debtor_messages}`);
    if (expect.max_cycle_seconds !== undefined && run.rail === "api" && run.cycle_seconds > expect.max_cycle_seconds) failures.push(`cycle_seconds ${run.cycle_seconds} > ${expect.max_cycle_seconds}`);
  }
  return { ok: failures.length === 0, mode: run.mode, failures, run };
}
