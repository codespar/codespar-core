/**
 * Module `batch-payout`. Section 2 of the spec, in one sentence: "um lote e
 * um laco de execucoes sob um mandato, com um `attempt_id` por chamada: uma
 * recusa nao derruba as outras, e repetir nao paga duas vezes."
 *
 * So a batch here is N executions, one per line, rather than one execution of
 * N items. Both shapes work — the core dispatches every attempt and names
 * every one — and the trade is about what the LIST is, not about whether a
 * refusal strands its siblings. See `docs/OPEN_QUESTIONS.md` § 40.
 *
 * A payroll wants this shape. One execution per line gives each line its own
 * `idempotency_key`, `attempt_id`, approval artifact with its own
 * `items_hash`, and terminal state, so a refusal is a fact about ONE payee
 * and line 57 with a wrong key is fixed and re-run ALONE, without sending the
 * other 199 back through approval.
 *
 * What that used to cost was the SET: each line was attested and the list was
 * not, so four lines approved and three run left a bundle that did not say a
 * fourth existed. `batch_hash` is what closes it (issue #21). The list is
 * hashed ONCE, before any line is drafted, over the same resolved items the
 * drafts will carry, and every line is drafted with that hash plus its own
 * position and the list's length. Each artifact of the batch therefore says
 * "line 2 of 4 of this exact list", and a bundle holding three of them says
 * so out loud.
 *
 * The four properties this module owns, and where each one lives:
 *
 *   one refusal does not stop the others  -> the loop `continue`s, never
 *                                            breaks, and never throws past
 *                                            the line it is on
 *   one attempt_id per call               -> the core derives it from each
 *                                            execution's own idempotency key
 *   repeating pays nobody twice           -> the per-line claim below
 *   the approved list is bound as a set   -> `batch_hash`, and the set claim
 *                                            that refuses a run whose list
 *                                            changed after it was approved
 *
 * The claim is what survives a re-run. Execution ids are random, so a second
 * run of the same batch would mint fresh ids, fresh idempotency keys and
 * fresh attempt ids, and the rail's own idempotence — which is keyed on
 * `attempt_id` — would not recognise them. The claim pairs (mandate, batch,
 * line) with the execution that covers it, durably, and the rules for
 * reading one back are the same posture the enterprise money paths take: a
 * line whose execution SETTLED is done, a line whose execution is still open
 * is in progress and is never re-opened, and only a line whose execution
 * ended without moving money is retried.
 */
import { batchHash, isTerminal, type Execution, type ExecutionItem, type ProposedItem, type ToolContext } from "@codespar/agent-core";
import { batchTotal, formatBRL, type Batch, type PayableLine } from "../payables.js";

/** What happened to one line of the batch. `dispatch` is the part an operator reads first. */
export interface BatchLineReport {
  /** This line's position in the presented list, from 0. The same index its artifact carries. */
  index: number;
  alias: string;
  beneficiary: string;
  amount: string;
  amount_minor: number;
  execution_id: string | null;
  state: string;
  reason: string | null;
  /** Whether this line's money moved, could not move, or was deliberately not attempted again. */
  dispatch: "settled" | "refused" | "awaiting_decision" | "uncertain" | "already_settled" | "in_progress";
}

/**
 * Why a whole batch was refused before any line was drafted. Today there is
 * one ground and it is the set binding: the list presented under this
 * `batch_ref` is not the list some line of it was already approved under.
 */
export interface BatchSetRefusal {
  reason: "batch_set_changed";
  detail: string;
  approved_batch_hash: string;
  presented_batch_hash: string;
  approved_count: number;
  presented_count: number;
}

export interface BatchReport {
  batch: string;
  label: string;
  /** The hash of the ordered lines as presented here. Every artifact this run mints carries it. */
  batch_hash: string;
  /** How many lines were presented. `lines` below holds exactly this many, refused or not. */
  line_count: number;
  lines: BatchLineReport[];
  settled_minor: number;
  settled: string;
  /** Lines that did not settle, by alias. The receipt of a batch says which failed. */
  failed: string[];
  /** Lines a previous run of this batch already covers. */
  skipped: string[];
  total_minor: number;
  total: string;
  /** Present when the SET was refused: nothing was drafted, nothing was sent, no line moved. */
  refused?: BatchSetRefusal;
}

/**
 * `claim:` is prefixed by the engine; what this module owns is everything
 * after it. The mandate is part of the key because a cursor is global to the
 * state file while an execution is not: two mandates may run a batch of the
 * same name and must not read each other's claims.
 */
function claimKey(mandateId: string, batchRef: string, alias: string): string {
  return `batch:${mandateId}:${batchRef}:${alias}`;
}

/**
 * The claim that names the SET rather than a line: which execution was the
 * first this batch ref ever drafted, and therefore which `batch_hash` the
 * lines of this ref were approved under. A later run that presents a
 * different list reads it and refuses.
 *
 * It is keyed `batchset:` and not `batch:` so it cannot collide with a line's
 * claim whatever a payee is called — an alias can hold any character, and a
 * separator a line could contain is not a separator.
 */
function setClaimKey(mandateId: string, batchRef: string): string {
  return `batchset:${mandateId}:${batchRef}`;
}

/**
 * The one place a line becomes a proposal. Both the hash computed before the
 * loop and the draft inside it go through here, so the list that was hashed
 * and the list that is drafted cannot drift into being two lists.
 */
function proposalFor(batch: Batch, line: PayableLine): ProposedItem {
  return { payee: line.alias, amount: line.amount_minor, description: `${batch.label}: ${line.reference}`, due_date: batch.due };
}

/**
 * The batch's lines as the core resolves them, in order. `preview` does not
 * throw, so a line the core would refuse still occupies its position: a batch
 * holding a broken line must not hash as the shorter batch without it.
 */
function presentedItems(batch: Batch, ctx: ToolContext): ExecutionItem[] {
  return ctx.engine.preview(batch.lines.map((line) => proposalFor(batch, line)));
}

/**
 * What a claim already held means for this line: skip it, or drop it and
 * pay. `undefined` means nothing is held and the line is paid normally.
 */
function priorVerdict(prior: Execution | undefined): "already_settled" | "in_progress" | undefined {
  // A claim naming an execution the store does not have is a claim taken by a
  // run that died before it drafted. Nothing moved, so the line is open.
  if (!prior) return undefined;
  if (prior.state === "settled") return "already_settled";
  // Open: it may yet reach the rail, or may already have. A second execution
  // for the same line is how a payee gets paid twice; the operator closes the
  // first one with `npm run approve`, `npm run resume` or `npm run reconcile`.
  if (!isTerminal(prior.state)) return "in_progress";
  // `denied`, `expired`, `failed`: the core refused it or the rail declined
  // it, and in every one of those the money provably did not move. Retry.
  return undefined;
}

function dispatchOf(execution: Execution): BatchLineReport["dispatch"] {
  if (execution.state === "settled") return "settled";
  if (execution.state === "awaiting_approval") return "awaiting_decision";
  // Still `executing` after the channel ran it: the rail did not say. Never
  // re-sent here; `npm run reconcile` is what closes it.
  if (execution.state === "executing") return "uncertain";
  return "refused";
}

/**
 * Runs the batch. One gate stands before the loop and refuses the whole run:
 * the set. Inside the loop nothing does — every exit from an individual line
 * is a `continue`, so a refusal, a claim already held, even a malformed line
 * is a fact recorded about that line and about nothing else.
 *
 * The two levels are the point. A line is refusable alone because a payroll
 * line is one payee's business; a LIST that is not the list somebody approved
 * is nobody's line to decide, so it never reaches the loop.
 */
export async function runBatch(batch: Batch, ctx: ToolContext): Promise<BatchReport> {
  const mandateId = ctx.engine.mandate.id;
  const lines: BatchLineReport[] = [];

  // The set is hashed HERE: before any line is drafted, over the whole
  // ordered list, so the hash every artifact carries is the hash of the list
  // as it was presented and not of the lines that happened to survive.
  const presented = batchHash(presentedItems(batch, ctx));
  const setKey = setClaimKey(mandateId, batch.ref);

  const refusal = setRefusal(batch, presented, ctx, setKey);
  if (refusal) {
    // A refused SET drafts nothing, so there is no per-line story to tell:
    // every line is reported refused under the one reason, which is also what
    // keeps the counts adding up to the list that was presented.
    ctx.engine.note("batch.set_refused", null, { batch_ref: batch.ref, ...refusal });
    return summarise(
      batch,
      presented,
      batch.lines.map((line, index) => ({ ...describe(line, index), execution_id: null, state: refusal.reason, reason: refusal.detail, dispatch: "refused" as const })),
      refusal,
    );
  }

  for (const [index, line] of batch.lines.entries()) {
    const key = claimKey(mandateId, batch.ref, line.alias);
    const held = ctx.engine.claimed(key);
    if (held) {
      const prior = ctx.engine.get(held);
      const verdict = priorVerdict(prior);
      if (verdict) {
        lines.push({ ...describe(line, index), execution_id: held, state: prior?.state ?? "unknown", reason: null, dispatch: verdict });
        continue;
      }
    }

    // `draft` REFUSES by returning, but it THROWS on a line the core cannot
    // read at all (a non-positive amount, a malformed due date). That is a
    // bug in the payables file rather than a refusal, and it still must not
    // take the rest of the payroll down with it: the line carries the
    // message and the siblings run.
    let draft: Awaited<ReturnType<typeof ctx.engine.draft>>;
    try {
      // The binding travels with the draft: the core stamps it on the
      // execution and every artifact minted for it carries it, so what a
      // person approved is a named position in a named list and not a
      // payment that happens to be near three others.
      draft = await ctx.engine.draft({
        items: [proposalFor(batch, line)],
        batch: { ref: batch.ref, batch_hash: presented, index, count: batch.lines.length },
      });
    } catch (err) {
      lines.push({ ...describe(line, index), execution_id: null, state: "unreadable_line", reason: err instanceof Error ? err.message : String(err), dispatch: "refused" });
      continue;
    }
    if (!draft.ok) {
      // Refused before an execution exists: nothing to claim, and the next
      // run of this batch tries the line again, which is right — the mandate
      // may have been re-signed by then.
      lines.push({ ...describe(line, index), execution_id: null, state: "refused_before_draft", reason: draft.reason, dispatch: "refused" });
      continue;
    }

    // The set claim names the first execution this ref ever drafted, and
    // through it the list that execution was presented inside. Taken here and
    // not before the loop: a run that drafted nothing approved nothing, and
    // has no set to bind a later run to.
    if (!ctx.engine.claimed(setKey)) ctx.engine.claim(setKey, draft.execution.id);

    // Claimed BEFORE the channel can run it, so a crash between here and the
    // rail leaves a claim on an OPEN execution, which the rule above reads as
    // "in progress" and refuses to duplicate. Claiming after would leave a
    // settled payment unclaimed, and that is the double payment.
    ctx.engine.claim(key, draft.execution.id);
    try {
      const execution = await ctx.onExecution(draft.execution);
      lines.push({ ...describe(line, index), execution_id: execution.id, state: execution.state, reason: execution.reason ?? null, dispatch: dispatchOf(execution) });
    } catch (err) {
      // The channel threw. Nothing about the siblings changed, so the batch
      // carries on — a throw that escaped this loop would cancel every line
      // after it, which is the failure this module exists to not have. The
      // line is reported `uncertain` and NOT as a refusal, because a throw
      // does not say whether the rail was reached; the claim is already
      // taken, so the next run reads the execution's state and refuses to
      // open a second one while it is still open.
      const current = ctx.engine.get(draft.execution.id);
      lines.push({
        ...describe(line, index),
        execution_id: draft.execution.id,
        state: current?.state ?? draft.execution.state,
        reason: err instanceof Error ? err.message : String(err),
        dispatch: "uncertain",
      });
    }
  }

  return summarise(batch, presented, lines);
}

/**
 * Is the list in front of us the list some line of this ref was already
 * approved under? The set claim names the first execution this ref drafted,
 * and that execution carries the hash it was presented with. A run that finds
 * a different one is running a list that changed after a person decided on
 * it, and there is no reading of that a payroll should act on.
 *
 * What it does NOT know is WHY the hash moved. A line left the list, an
 * amount moved, or the mandate was re-signed and now pins a different key for
 * one of these payees — all three change the same hash, because all three
 * change where money goes. The refusal names what it measured, offers both
 * ways out, and asserts no cause it cannot see.
 *
 * `undefined` when nothing is held (a first run: there is no approved set to
 * contradict) or when the held execution is gone from the store (a claim
 * taken by a run that died before it drafted — it attested nothing).
 */
function setRefusal(batch: Batch, presented: string, ctx: ToolContext, setKey: string): BatchSetRefusal | undefined {
  const held = ctx.engine.claimed(setKey);
  const approved = held ? ctx.engine.get(held)?.batch : undefined;
  if (!approved || approved.batch_hash === presented) return undefined;
  return {
    reason: "batch_set_changed",
    detail:
      `${batch.ref} was approved as a list of ${approved.count} line(s) hashing to ${approved.batch_hash}; ` +
      `the list here is ${batch.lines.length} line(s) hashing to ${presented}. The set a person decided on is not the set in front of us, ` +
      `so no line of it runs. A line left the list, an amount moved, or the mandate now pins a different key for one of these payees: ` +
      `whichever it was, restore the approved list, or present the new one under a batch_ref of its own.`,
    approved_batch_hash: approved.batch_hash,
    presented_batch_hash: presented,
    approved_count: approved.count,
    presented_count: batch.lines.length,
  };
}

function summarise(batch: Batch, presented: string, lines: BatchLineReport[], refused?: BatchSetRefusal): BatchReport {
  const settledMinor = lines.filter((l) => l.dispatch === "settled").reduce((sum, l) => sum + l.amount_minor, 0);
  const total = batchTotal(batch);
  return {
    batch: batch.ref,
    label: batch.label,
    batch_hash: presented,
    line_count: batch.lines.length,
    lines,
    settled_minor: settledMinor,
    settled: formatBRL(settledMinor),
    failed: lines.filter((l) => l.dispatch === "refused" || l.dispatch === "uncertain").map((l) => l.alias),
    skipped: lines.filter((l) => l.dispatch === "already_settled" || l.dispatch === "in_progress").map((l) => l.alias),
    total_minor: total,
    total: formatBRL(total),
    ...(refused ? { refused } : {}),
  };
}

function describe(line: PayableLine, index: number): Pick<BatchLineReport, "index" | "alias" | "beneficiary" | "amount" | "amount_minor"> {
  return { index, alias: line.alias, beneficiary: line.name, amount: formatBRL(line.amount_minor), amount_minor: line.amount_minor };
}

/**
 * What a previous run of this batch left on one line, for the read tool. The
 * same claim the loop reads, so what the model is told and what the loop
 * would do cannot drift.
 */
export function lineStatus(batch: Batch, line: PayableLine, ctx: ToolContext): "open" | "already_settled" | "in_progress" {
  const held = ctx.engine.claimed(claimKey(ctx.engine.mandate.id, batch.ref, line.alias));
  if (!held) return "open";
  return priorVerdict(ctx.engine.get(held)) ?? "open";
}
