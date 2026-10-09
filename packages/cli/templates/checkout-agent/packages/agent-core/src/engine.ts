/**
 * Section 4.6: the model proposes, the code executes. The model's only way
 * in is `draft()`, which creates an execution in `drafted` and nothing else.
 * Every check that decides whether money moves lives here, in
 * deterministic code: mandate status, allowlist, per-transaction and window
 * caps, `escalate_above`, the approval artifact and its `items_hash`.
 *
 * The policy runs THREE times, not once: at draft, when a human approves,
 * and immediately before `executing`, inside the same transaction that
 * writes the outbox row. A list that changed after approval, a window that
 * filled up between approval and execution, or a mandate revoked in the
 * meantime is caught at the last gate, which is the only one that matters.
 */
import { checkApprovalArtifact, createApprovalArtifact, type ApprovalSigner } from "./approval.js";
import { maskPayee, type ProofBundle } from "./bundle.js";
import { evaluateEscalation, localDate, type Escalation } from "./escalate.js";
import { CHARGE_CANCELLED, CHARGE_EXPIRED, CHARGE_PAID, PAYMENT_FAILED, PAYMENT_SUCCEEDED, type PublishedEvent } from "./events.js";
import type { Guardrails } from "./guardrails.js";
import { batchAttemptId, itemsHash, sha256Hex } from "./hash.js";
import { newId } from "./ids.js";
import { mandateExpired, payeeAllowed, resolveBeneficiary, windowCap, windowStart, type Mandate } from "./mandate.js";
import type { Manifest } from "./manifest.js";
import { checkQuote, quoteFromApproval } from "./quote.js";
import { sameWireActor, spendApprovalOf, wireActorOf, type PaymentRail, type RailOutcome, type RailPayment, type SealedSpendApproval, type SpendApproval } from "./rail.js";
import { sameApprovalHash } from "./receipt-chain.js";
import type { MandateStatusReport, MandateStatusSource } from "./revocation.js";
import { isTerminal, transition, type Execution, type ExecutionState, type RailAnswer } from "./state-machine.js";
import type { StateStore } from "./state/store.js";
import type { Actor, ApprovalArtifact, ApprovalMode, ExecutionBatch, ExecutionComposition, ExecutionItem, ExecutionReason, ItemOutcome } from "./types.js";

export interface ProposedItem {
  /** An alias from the mandate's named payees, or a raw payee key. */
  payee: string;
  amount: number;
  description?: string;
  /** A receivable's due date, `YYYY-MM-DD`. */
  due_date?: string;
}

export interface PolicyExtensionContext {
  gate: "draft" | "approve" | "execute";
  now: Date;
  mode: ApprovalMode;
  mandate: Mandate;
  guardrails: Guardrails;
}

/**
 * The kit's own deterministic check, run by the core at every gate after
 * the mandate's (allowlist, caps, window). It can only refuse; it cannot
 * widen anything. A collections agent uses it for its negotiation envelope.
 */
export type PolicyExtension = (execution: Execution, ctx: PolicyExtensionContext) => { reason: ExecutionReason; detail: string } | undefined;

export interface Proposal {
  items: ProposedItem[];
  /** What the model said the total was. Recorded; never used to pay. */
  claimed_total?: number;
  /**
   * The batch this proposal is one line of, when it is one. The kit computes
   * it once over the whole ordered list before drafting any of it; the core
   * stamps it on the execution and every artifact of that execution carries
   * it. The core never invents one and never fills one in.
   */
  batch?: ExecutionBatch;
  /**
   * What the proposal's amount is composed of, when it is composed of lines
   * (a cart behind one order). The kit computes `compositionHash` over the
   * resolved lines; the core stamps it on the execution and every artifact of
   * it, and never computes, fills in or reads the lines.
   */
  composition?: ExecutionComposition;
}

export type DraftResult =
  | { ok: true; execution: Execution }
  | { ok: false; refused_before_draft: true; reason: ExecutionReason; message: string };

export interface EngineDeps {
  store: StateStore;
  rail: PaymentRail;
  status: MandateStatusSource;
  signer: ApprovalSigner;
  manifest: Manifest;
  guardrails: Guardrails;
  mandate: Mandate;
  bundle: ProofBundle;
  mode: ApprovalMode;
  runId: string;
  /** The person the agent acts for. */
  onBehalfOf: string;
  clock?: () => Date;
  /** The kit's own envelope check, run at every gate after the mandate's. */
  policyExtension?: PolicyExtension | undefined;
}

/** What the deterministic policy says about an execution at one of its three gates. */
type Verdict =
  | { kind: "ok" }
  | { kind: "deny"; reason: ExecutionReason; detail: string }
  | { kind: "block"; reason: ExecutionReason; detail: string }
  | { kind: "escalate"; escalation: Escalation };

type Gate = "draft" | "approve" | "execute";

/**
 * How many spent generations of one batch line's attempt id a dispatch walks
 * past before it reports the line failed. Each one is a payment the provider
 * already refused for this exact line, so eight is a line that keeps failing,
 * not a line still looking for its id.
 */
const MAX_ATTEMPT_GENERATION = 8;

/** Open executions reserve the window: a cap is a ceiling on what may be committed, not a balance. */
const WINDOW_STATES: ExecutionState[] = ["awaiting_approval", "approved", "executing", "settled"];

export class ExecutionEngine {
  readonly clock: () => Date;
  readonly agentActor: Actor;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.agentActor = { type: "agent", agent: `${deps.manifest.name}@${deps.manifest.version}`, on_behalf_of: deps.onBehalfOf };
  }

  get mode(): ApprovalMode {
    return this.deps.mode;
  }

  get mandate(): Mandate {
    return this.deps.mandate;
  }

  /**
   * The day it is for the person, in the guardrails' timezone, at this
   * engine's clock (so `--now` pins it too). A tool that shows a due date
   * shows this next to it: the model has no calendar of its own, and without
   * it a bill due next week reads as one that already fell due.
   */
  today(): string {
    return localDate(this.clock(), this.deps.guardrails.timezone);
  }

  // ---- the model's only entry point -------------------------------------

  async draft(proposal: Proposal): Promise<DraftResult> {
    const now = this.clock();
    const gate = await this.mandateGate();
    if (gate) {
      this.record("execution.refused_before_draft", null, { reason: gate.reason, detail: gate.detail });
      return { ok: false, refused_before_draft: true, reason: gate.reason, message: gate.detail };
    }

    const items = proposal.items.map((p) => this.resolveItem(p));
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    if (proposal.batch) assertBatchBinding(proposal.batch);
    if (proposal.composition) assertCompositionBinding(proposal.composition);
    const id = newId("exe");
    const execution: Execution<"drafted"> = {
      id,
      run_id: this.deps.runId,
      state: "drafted",
      mode: this.deps.mode,
      actor: this.agentActor,
      items,
      total,
      currency: this.deps.mandate.currency,
      ...(proposal.claimed_total !== undefined ? { model_claimed_total: proposal.claimed_total } : {}),
      items_hash: itemsHash(items),
      ...(proposal.batch ? { batch: proposal.batch } : {}),
      ...(proposal.composition ? { composition: proposal.composition } : {}),
      mandate: { id: this.deps.mandate.id, version: this.deps.mandate.version },
      idempotency_key: `idk_${sha256Hex(`${this.deps.runId}:${id}`).slice(0, 32)}`,
      blocking_reasons: [],
      outcomes: [],
      history: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.deps.store.saveExecution(execution);
    this.record("execution.drafted", id, { items: execution.items, total, model_claimed_total: proposal.claimed_total ?? null, mode: this.deps.mode, batch: execution.batch ?? null, ...(execution.composition ? { composition: execution.composition } : {}) });

    return { ok: true, execution: await this.evaluateDraft(execution) };
  }

  /**
   * The proposal behind an OPEN execution changed, and the execution follows
   * it: a customer who changes the cart after the order was approved is
   * changing the order, not opening a second one. The items, the total, the
   * `items_hash` and the composition are replaced; the state, the approval
   * and the idempotency key are NOT.
   *
   * That is the point. No transition happens here and nothing is judged: an
   * `approved` execution keeps the artifact it was approved with, and the
   * last gate (`execute`) compares the two and sends it back to
   * `awaiting_approval` with `items_hash_mismatch` — the same edge a list
   * tampered after approval takes, reached honestly. An `awaiting_approval`
   * one is judged again by whoever decides it, on what it says now.
   *
   * The payees may not change, in number or in order: a restatement changes
   * what is charged or paid, never to whom. Nothing is dispatched by an open
   * execution, so no attempt can exist under the key it keeps.
   */
  restate(executionId: string, proposal: Proposal): Execution {
    const execution = this.mustGet(executionId);
    if (execution.state !== "awaiting_approval" && execution.state !== "approved") throw new Error(`execution ${executionId} is ${execution.state}; only an open execution (awaiting_approval, approved) can be restated`);
    if (proposal.batch) throw new Error("a batch line is not restated; the batch is presented again");
    if (proposal.composition) assertCompositionBinding(proposal.composition);
    const items = proposal.items.map((p) => this.resolveItem(p));
    const before = execution.items.map((i) => i.payee);
    if (items.length !== before.length || items.some((item, i) => item.payee !== before[i])) throw new Error(`execution ${executionId}: a restatement may not change the payees`);
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    const { composition: _composition, model_claimed_total: _claimed, ...rest } = execution;
    const restated: Execution = {
      ...rest,
      items,
      total,
      ...(proposal.claimed_total !== undefined ? { model_claimed_total: proposal.claimed_total } : {}),
      items_hash: itemsHash(items),
      ...(proposal.composition ? { composition: proposal.composition } : {}),
      updated_at: this.clock().toISOString(),
    };
    this.deps.store.saveExecution(restated);
    this.record("execution.restated", execution.id, {
      state: execution.state,
      items_hash: { from: execution.items_hash, to: restated.items_hash },
      total: { from: execution.total, to: total },
      composition: { from: execution.composition ?? null, to: restated.composition ?? null },
    });
    return restated;
  }

  // ---- deterministic policy ---------------------------------------------

  /**
   * The one policy, run at every gate. `humanApproved` is true when a person
   * already decided this execution: their decision satisfies `escalate_above`,
   * and only that. Everything else — allowlist, caps, window — is the
   * mandate's and no approval widens it.
   */
  private policy(execution: Execution, now: Date, gate: Gate, humanApproved: boolean): Verdict {
    const { mandate, guardrails, manifest } = this.deps;

    if (gate === "draft" && execution.model_claimed_total !== undefined && execution.model_claimed_total !== execution.total) {
      const detail = `the model stated ${execution.model_claimed_total}; the core computed ${execution.total} and that is the only number that counts`;
      if (guardrails.model_total_mismatch === "refuse") return { kind: "deny", reason: "model_total_mismatch", detail };
      this.record("execution.model_total_ignored", execution.id, { detail });
    }

    const blocked = execution.items.filter((i) => !payeeAllowed(mandate, i.payee));
    if (blocked.length > 0) {
      const detail = `payee not named in the signed allowlist: ${blocked.map((i) => i.beneficiary).join(", ")}`;
      // At draft in `human` the person is told; at any later gate, or in `mandate`, it is a refusal. escalate_above never widens the allowlist.
      if (gate === "draft" && this.deps.mode === "human") return { kind: "block", reason: "beneficiary_not_allowed", detail };
      return { kind: "deny", reason: "beneficiary_not_allowed", detail };
    }

    // A receivable closed `charge_reference_ambiguous` was issued and may still be paid. Another one to the same payee is how a debtor pays twice.
    const unreconciled = this.deps.store
      .listExecutions({ state: "failed", mandate_id: mandate.id })
      .find((e) => e.id !== execution.id && e.reason === "charge_reference_ambiguous" && e.items.some((i) => execution.items.some((mine) => mine.payee === i.payee)));
    if (unreconciled) {
      return { kind: "deny", reason: "charge_reference_ambiguous", detail: `execution ${unreconciled.id} issued a receivable to this payee whose reference turned ambiguous; reconcile it by the charge id before issuing another` };
    }

    const over = execution.items.find((i) => i.amount > mandate.per_tx_cap_minor);
    if (over) return { kind: "deny", reason: "per_tx_cap_exceeded", detail: `${over.beneficiary}: ${over.amount} is above the per-payment cap ${mandate.per_tx_cap_minor}` };

    const committed = this.committedInWindow(now, execution.id);
    if (committed + execution.total > windowCap(mandate)) {
      return {
        kind: "deny",
        reason: "window_cap_exceeded",
        detail: `${committed} already committed this ${mandate.periodic_cap?.window ?? "month"} (settled, in flight and awaiting a decision) plus ${execution.total} exceeds the cap ${windowCap(mandate)}`,
      };
    }

    // The kit's envelope, at every gate: a person's yes does not widen it either.
    const outside = this.deps.policyExtension?.(execution, { gate, now, mode: this.deps.mode, mandate, guardrails });
    if (outside) return { kind: "deny", reason: outside.reason, detail: outside.detail };

    if (this.deps.mode === "mandate" && !humanApproved) {
      const escalation = evaluateEscalation(manifest.escalate_above, guardrails, execution.items, {
        now,
        timezone: guardrails.timezone,
        knownPayees: this.knownPayees(),
        recentByPayee: this.recentByPayee(now, execution.id),
      });
      if (escalation) {
        if (escalation.trigger === "outside_hours" && guardrails.outside_hours_action === "refuse") return { kind: "deny", reason: "outside_hours", detail: escalation.detail };
        return { kind: "escalate", escalation };
      }
    }

    return { kind: "ok" };
  }

  private async evaluateDraft(execution: Execution<"drafted">): Promise<Execution> {
    const now = this.clock();
    const at = now.toISOString();
    const gate = await this.mandateGate();
    if (gate) return this.persist(transition(execution, gate.to, { at, actor: this.agentActor, reason: gate.reason, detail: gate.detail }));

    const verdict = this.policy(execution, now, "draft", false);
    switch (verdict.kind) {
      case "deny":
        return this.persist(transition(execution, "denied", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      case "block":
        return this.persist(transition({ ...execution, blocking_reasons: [verdict.reason] }, "awaiting_approval", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      case "escalate":
        return this.persist(transition({ ...execution, escalation: verdict.escalation }, "awaiting_approval", { at, actor: this.agentActor, reason: "escalated", detail: `${verdict.escalation.trigger}: ${verdict.escalation.detail}` }));
      case "ok":
        break;
    }
    if (this.deps.mode === "human") return this.persist(transition(execution, "awaiting_approval", { at, actor: this.agentActor }));

    // The allowance covers it: the approver is the mandate, and the artifact says so.
    const artifact = createApprovalArtifact(this.deps.signer, {
      execution,
      approver: { type: "mandate", id: this.deps.mandate.id },
      actor: this.agentActor,
      now,
      ttlMs: this.deps.guardrails.approval_ttl_minutes * 60_000,
    });
    this.storeApproval(artifact);
    return this.persist(transition({ ...execution, approval_id: artifact.approval_id }, "approved", { at, actor: this.agentActor, detail: "within the signed allowance" }));
  }

  // ---- the human's entry points -----------------------------------------

  approve(executionId: string, approver: { id: string; channel: string }): Execution {
    const execution = this.mustGet(executionId);
    if (execution.state !== "awaiting_approval") throw new Error(`execution ${executionId} is ${execution.state}, not awaiting_approval`);
    const now = this.clock();
    const at = now.toISOString();
    const humanActor: Actor = { type: "human", id: approver.id, channel: approver.channel };
    const awaiting = execution as Execution<"awaiting_approval">;
    if (execution.blocking_reasons.length > 0) {
      const reason = execution.blocking_reasons[0] as ExecutionReason;
      return this.persist(transition(awaiting, "denied", { at, actor: humanActor, reason, detail: `a human said yes, but ${reason} cannot be approved: the mandate does not authorize it` }));
    }
    // A yes does not skip the policy: the list may have changed since it was presented (4.2), or the window may have filled.
    const verdict = this.policy(execution, now, "approve", true);
    if (verdict.kind === "deny") return this.persist(transition(awaiting, "denied", { at, actor: humanActor, reason: verdict.reason, detail: `a human said yes, but ${verdict.detail}` }));

    const artifact = createApprovalArtifact(this.deps.signer, {
      execution,
      approver: { type: "person", id: approver.id, channel: approver.channel },
      actor: humanActor,
      now,
      ttlMs: this.deps.guardrails.approval_ttl_minutes * 60_000,
      ...(execution.escalation ? { escalation: execution.escalation } : {}),
    });
    this.storeApproval(artifact);
    return this.persist(transition({ ...awaiting, approval_id: artifact.approval_id }, "approved", { at, actor: humanActor }));
  }

  deny(executionId: string, approver: { id: string; channel: string }, detail = "denied by the approver"): Execution {
    const execution = this.mustGet(executionId);
    if (execution.state !== "awaiting_approval") throw new Error(`execution ${executionId} is ${execution.state}, not awaiting_approval`);
    const humanActor: Actor = { type: "human", id: approver.id, channel: approver.channel };
    return this.persist(transition(execution as Execution<"awaiting_approval">, "denied", { at: this.clock().toISOString(), actor: humanActor, reason: "denied_by_approver", detail }));
  }

  // ---- the only path to `executing` -------------------------------------

  async execute(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "approved") throw new Error(`execution ${executionId} is ${execution.state}, not approved`);
    const now = this.clock();
    const at = now.toISOString();
    const approved = execution as Execution<"approved">;

    // 4.7: the artifact may predate a revocation. Ask the source, every time.
    const gate = await this.mandateGate();
    if (gate) return this.persist(transition(approved, gate.to, { at, actor: this.agentActor, reason: gate.reason, detail: gate.detail }));

    const artifact = execution.approval_id ? this.deps.store.getApproval(execution.approval_id) : undefined;
    if (!artifact) throw new Error(`execution ${executionId} is approved without an approval artifact`);

    // Everything below is one transaction: the last policy run, the artifact check, the outbox row and the state change land together or not at all.
    const payments = this.paymentsFor(execution, artifact);
    const decided = this.deps.store.transaction((): Execution => {
      // The approval was given under one mandate; a re-signed one (new version) is a new authorization, and the person decides again under it.
      const current = { id: this.deps.mandate.id, version: this.deps.mandate.version };
      if (execution.mandate.id !== current.id || execution.mandate.version !== current.version) {
        return this.persist(transition({ ...this.withoutApproval(approved), mandate: current }, "awaiting_approval", { at, actor: this.agentActor, reason: "mandate_changed", detail: `approved under mandate ${execution.mandate.id} v${execution.mandate.version}; the mandate is now ${current.id} v${current.version}` }));
      }
      // 4.2: recompute the hash of what is about to be executed and compare.
      const check = checkApprovalArtifact(this.deps.signer, artifact, execution, now);
      if (!check.ok) {
        if (check.problem === "expired") {
          return this.persist(transition(approved, "expired", { at, actor: this.agentActor, reason: "approval_expired", detail: `approval ${artifact.approval_id} expired at ${artifact.expires_at}` }));
        }
        return this.persist(transition(this.withoutApproval(approved), "awaiting_approval", { at, actor: this.agentActor, reason: "items_hash_mismatch", detail: `approval ${artifact.approval_id} does not match what would be executed (${check.problem})` }));
      }
      // The API only records a quote that disagrees with the spend, and pays anyway. The kit does not send one.
      const unquoted = payments.map(checkQuote).find((q) => !q.ok);
      if (unquoted && !unquoted.ok) return this.persist(transition(approved, "denied", { at, actor: this.agentActor, reason: "quote_mismatch", detail: `${unquoted.code}: ${unquoted.detail}; nothing was sent` }));

      const verdict = this.policy(execution, now, "execute", artifact.approver.type === "person");
      if (verdict.kind === "deny" || verdict.kind === "block") {
        return this.persist(transition(approved, "denied", { at, actor: this.agentActor, reason: verdict.reason, detail: verdict.detail }));
      }
      if (verdict.kind === "escalate") {
        return this.persist(transition({ ...this.withoutApproval(approved), escalation: verdict.escalation }, "awaiting_approval", { at, actor: this.agentActor, reason: "escalated", detail: `${verdict.escalation.trigger}: ${verdict.escalation.detail}` }));
      }

      this.deps.store.putOutbox({
        idempotency_key: execution.idempotency_key,
        execution_id: execution.id,
        kind: "rail.pay",
        payload: { attempts: payments.map((p) => p.attempt_id), items: execution.items },
        status: "pending",
        response: undefined,
        created_at: at,
      });
      return this.persist(transition(approved, "executing", { at, actor: this.agentActor, detail: `idempotency_key ${execution.idempotency_key}` }));
    });
    if (decided.state !== "executing") return decided;

    return this.dispatch(decided as Execution<"executing">, payments);
  }

  /**
   * Sends the attempts of an `executing` execution to the rail. The outbox row
   * flips to `sent` BEFORE the first call, so a crash after that point is
   * reconciled and never re-sent.
   */
  private async dispatch(execution: Execution<"executing">, payments: RailPayment[]): Promise<Execution> {
    const outcomes: ItemOutcome[] = [...execution.outcomes];
    const unknown: string[] = [];
    const unknownAnswers: RailAnswer[] = [];
    const sealMismatches: string[] = [];
    this.deps.store.updateOutbox(execution.idempotency_key, "sent", undefined, this.clock().toISOString());

    const generations: Record<number, number> = { ...execution.attempt_generations };
    for (const [index, presented] of payments.entries()) {
      if (outcomes.some((o) => o.index === index)) continue;
      let payment = presented;
      // The dispatch line is the request. `idempotency_key` is what makes a retry the same payment, so the bundle names it next to the attempt.
      this.record("rail.dispatch", execution.id, { attempt_id: payment.attempt_id, payee: payment.payee, amount: payment.amount_minor, rail: this.deps.rail.name, idempotency_key: execution.idempotency_key });
      let outcome = await this.deps.rail.pay(payment);
      this.record("rail.outcome", execution.id, { attempt_id: payment.attempt_id, status: outcome.status, ...railAnswer(outcome) });
      // A batch line whose derived id the rail holds as failed-with-no-money
      // moves to the next generation of it, and only on that answer (see
      // `batchAttemptId`). The generation is saved before the next id goes
      // out, so a crash or an unknown answer is reconciled against the id
      // that was actually sent.
      while (execution.batch && outcome.status === "failed" && outcome.spent && (generations[index] ?? 0) < MAX_ATTEMPT_GENERATION) {
        const generation = (generations[index] ?? 0) + 1;
        const next = batchAttemptId(execution.mandate.id, execution.batch, index, generation);
        this.record("rail.attempt_spent", execution.id, { attempt_id: payment.attempt_id, code: outcome.code, next_attempt_id: next, generation });
        generations[index] = generation;
        this.deps.store.saveExecution({ ...execution, outcomes, attempt_generations: { ...generations }, updated_at: this.clock().toISOString() });
        payment = { ...payment, attempt_id: next };
        this.record("rail.dispatch", execution.id, { attempt_id: payment.attempt_id, payee: payment.payee, amount: payment.amount_minor, rail: this.deps.rail.name, idempotency_key: execution.idempotency_key });
        outcome = await this.deps.rail.pay(payment);
        this.record("rail.outcome", execution.id, { attempt_id: payment.attempt_id, status: outcome.status, ...railAnswer(outcome) });
      }
      if (outcome.status === "uncertain") {
        this.record("rail.uncertain", execution.id, { attempt_id: payment.attempt_id, code: outcome.code, message: outcome.message });
        // No outcome is recorded because there is none. The siblings are still
        // sent: an unknown answer about THIS payee says nothing about the next
        // one, and the execution stays open until reconciliation settles it.
        unknown.push(`attempt ${payment.attempt_id}: ${outcome.code} — outcome unknown, kept for reconciliation`);
        unknownAnswers.push({ attempt_id: payment.attempt_id, code: outcome.code, message: outcome.message });
        continue;
      }
      if (outcome.status === "failed") {
        outcomes.push({ index, attempt_id: payment.attempt_id, status: "failed", code: outcome.code, message: outcome.message, error: `${outcome.code}: ${outcome.message}`, ...(outcome.held ? { held: outcome.held } : {}) });
        continue;
      }
      if (outcome.status === "accepted") {
        // A receivable was issued; the payer decides the rest. Nothing settles here.
        outcomes.push({ index, attempt_id: payment.attempt_id, status: "accepted", transaction_id: outcome.transaction_id, instrument: outcome.instrument });
        this.recordInstrument(execution.id, payment.attempt_id, outcome.transaction_id, outcome.instrument);
        continue;
      }
      outcomes.push({ index, attempt_id: payment.attempt_id, status: "settled", transaction_id: outcome.transaction_id, ...(outcome.receipt_id ? { receipt_id: outcome.receipt_id } : {}), ...(outcome.replayed ? { replayed: true as const } : {}) });
      const mismatch = await this.ingestSettlement(execution, index, payment, outcome.receipt_id, PAYMENT_SUCCEEDED);
      if (mismatch) sealMismatches.push(mismatch);
    }
    const answers = [...(execution.uncertain_answers ?? []).filter((a) => !unknownAnswers.some((u) => u.attempt_id === a.attempt_id)), ...unknownAnswers];
    const closed = this.close(
      { ...execution, outcomes, ...(Object.keys(generations).length > 0 ? { attempt_generations: generations } : {}), ...(answers.length > 0 ? { uncertain_answers: answers } : {}) },
      payments.length,
      unknown.join("; ") || undefined,
    );
    if (sealMismatches.length > 0) throw new ReceiptSealMismatchError(execution.id, sealMismatches);
    return closed;
  }

  /**
   * Closes an `executing` execution from its recorded outcomes: stays while a
   * receivable is accepted and unpaid, stays while any attempt has no outcome
   * at all, failed if any attempt failed, settled when every attempt settled.
   *
   * The order matters. An execution does not close while one of its attempts
   * is unknown, even when another one failed: "some of this moved and one of
   * them we cannot see" is not a closed outcome, and closing it as `failed`
   * would report a batch as finished while a payment may still be in flight.
   */
  private close(execution: Execution<"executing">, attempts: number, unknownDetail?: string): Execution {
    const at = this.clock().toISOString();
    const updated: Execution<"executing"> = { ...execution, updated_at: at };
    const accepted = execution.outcomes.filter((o) => o.status === "accepted");
    if (accepted.length > 0) {
      return this.leaveAwaiting(updated, `${accepted.length} receivable(s) issued and unpaid: ${accepted.map((o) => o.transaction_id ?? o.attempt_id).join(", ")}`);
    }
    if (execution.outcomes.length < attempts) {
      return this.leaveUnresolved(updated, unknownDetail ?? `${execution.outcomes.length} of ${attempts} attempt(s) have an outcome`);
    }
    const failed = decisiveFailure(execution.outcomes);
    if (failed) {
      this.deps.store.updateOutbox(execution.idempotency_key, "failed", execution.outcomes, at);
      // `org_paused` is the API refusing the spend itself: the kill switch was pressed after the gate read the status. Nothing moved.
      const reason: ExecutionReason =
        failed.code === "charge_expired" || failed.code === "charge_cancelled" || failed.code === "charge_issuer_error" || failed.code === "org_paused" || failed.code === "charge_reference_ambiguous" ? failed.code : "rail_failed";
      return this.persist(transition(updated, "failed", { at, actor: this.agentActor, reason, detail: failed.error ?? "rail refused" }));
    }
    if (execution.outcomes.filter((o) => o.status === "settled").length === attempts) {
      this.deps.store.updateOutbox(execution.idempotency_key, "done", execution.outcomes, at);
      return this.persist(transition(updated, "settled", { at, actor: this.agentActor }));
    }
    return this.leaveUnresolved(updated, `${execution.outcomes.length} of ${attempts} attempt(s) have an outcome`);
  }

  private leaveUnresolved(execution: Execution<"executing">, detail: string): Execution {
    const kept: Execution<"executing"> = { ...execution, reason: "rail_uncertain", detail, updated_at: this.clock().toISOString() };
    this.deps.store.saveExecution(kept);
    this.record("execution.uncertain", execution.id, { detail });
    return kept;
  }

  /** A receivable is out and its payer has not acted. Not uncertain: the rail knows the attempt; the outcome is simply not yet decided. */
  private leaveAwaiting(execution: Execution<"executing">, detail: string): Execution {
    const kept: Execution<"executing"> = { ...execution, reason: "awaiting_settlement", detail, updated_at: this.clock().toISOString() };
    this.deps.store.saveExecution(kept);
    // Deduplicated on what was observed, so a poll every few seconds does not fill the log with the same line.
    const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: execution.id, event_id: `awaiting:${execution.id}:${sha256Hex(detail).slice(0, 16)}`, type: "execution.awaiting_settlement", payload: { detail }, at: kept.updated_at });
    if (stored) this.deps.bundle.event({ ...stored, actor: this.agentActor });
    return kept;
  }

  /** The instrument the payer is shown, logged once per observed state (registration flips `payable`; the log says when). */
  private recordInstrument(executionId: string, attemptId: string, transactionId: string, instrument: ItemOutcome["instrument"]): void {
    if (!instrument) return;
    const stored = this.deps.store.appendEvent({
      run_id: this.deps.runId,
      execution_id: executionId,
      event_id: `instrument:${attemptId}:${instrument.status}:${instrument.payable ? "payable" : "not-payable"}`,
      type: "charge.instrument",
      payload: { attempt_id: attemptId, charge_id: transactionId, status: instrument.status, payable: instrument.payable, has_pix: instrument.pix_copy_paste !== null, has_boleto: instrument.boleto_bank_line !== null, due_date: instrument.due_date },
      at: this.clock().toISOString(),
    });
    if (stored) this.deps.bundle.event({ ...stored, actor: this.agentActor });
  }

  /** Records a settled attempt and fetches its receipt; answers the seal mismatch, if the receipt disagrees with what was paid. */
  private async ingestSettlement(execution: Execution, index: number, payment: RailPayment, receiptId: string | null, eventType: PublishedEvent): Promise<string | undefined> {
    // The rail's answer is the settlement event the API publishes (section 4.3): `commerce.payment.succeeded` for a payout, `commerce.charge.paid` for a receivable. Keyed by attempt so a replay is a no-op.
    const appended = this.deps.store.appendEvent({
      run_id: this.deps.runId,
      execution_id: execution.id,
      event_id: `succeeded:${payment.attempt_id}`,
      type: eventType,
      payload: { attempt_id: payment.attempt_id, amount: payment.amount_minor, payee: payment.payee, receipt_id: receiptId, actor: this.agentActor },
      at: this.clock().toISOString(),
    });
    if (appended) this.deps.bundle.event({ ...appended, actor: this.agentActor, item_index: index });
    return receiptId ? this.saveReceipt(execution.id, receiptId, payment) : undefined;
  }

  /**
   * The bundle's copy is the receipt as it was sealed, payee included. A
   * payment receipt whose sealed payee is not the payee this attempt paid —
   * including one that sealed no payee — is recorded and answered as a
   * mismatch, which the caller raises once the execution's outcome is saved:
   * the money is where the rail says it is, and it is the EVIDENCE that
   * disagrees. The same holds for the approval link (§3): a receipt that
   * seals other hashes than the ones this attempt sent, or none, does not
   * say this payment was made against the approved list. A rail that cannot
   * report the link leaves it `undefined`, and nothing is compared. A paid
   * charge carries no seal, so there is nothing to compare at all.
   */
  private async saveReceipt(executionId: string, receiptId: string, payment: RailPayment): Promise<string | undefined> {
    const receipt = await this.deps.rail.receipt(receiptId, this.agentActor);
    if (!receipt) return undefined;
    const path = this.deps.bundle.receipt(receipt, { approval_id: this.deps.store.getExecution(executionId)?.approval_id });
    this.record("receipt.saved", executionId, { receipt_id: receiptId, path });
    if (receipt.kind === "charge") return undefined;
    const mismatches: string[] = [];
    if (receipt.payment.payee !== payment.payee) {
      const sealed = receipt.payment.payee === null ? null : maskPayee(receipt.payment.payee);
      this.record("receipt.seal_mismatch", executionId, { receipt_id: receiptId, attempt_id: payment.attempt_id, sealed_payee: sealed, paid_payee: maskPayee(payment.payee) });
      mismatches.push(`receipt ${receiptId} seals payee ${sealed ?? "none"}; attempt ${payment.attempt_id} paid ${maskPayee(payment.payee)}`);
    }
    if (receipt.approval !== undefined && payment.approval && !sealsApproval(receipt.approval, payment.approval)) {
      this.record("receipt.seal_mismatch", executionId, { receipt_id: receiptId, attempt_id: payment.attempt_id, sealed_approval: receipt.approval, sent_approval: payment.approval });
      mismatches.push(`receipt ${receiptId} seals approval ${receipt.approval ? receipt.approval.items_hash : "none"}; attempt ${payment.attempt_id} sent ${payment.approval.items_hash}`);
    }
    // §2: the actor the spend declared, as the API recorded it. A different one, or none, is an event and not a seal mismatch:
    // the money and its link to the approval are what the receipt proves, and who triggered it is what it RECORDS.
    if (receipt.sealed_actor !== undefined && !sameWireActor(receipt.sealed_actor, wireActorOf(payment.actor))) {
      this.record("receipt.actor_mismatch", executionId, { receipt_id: receiptId, attempt_id: payment.attempt_id, sealed_actor: receipt.sealed_actor, sent_actor: wireActorOf(payment.actor) });
    }
    return mismatches.length > 0 ? mismatches.join("; ") : undefined;
  }


  /**
   * Fetches into the bundle the receipts of settled attempts the bundle does
   * not hold yet (a settlement that arrived by event names a receipt id and
   * nothing else). Read-only on the rail; never dispatches.
   */
  async collectReceipts(executionId: string): Promise<string[]> {
    const execution = this.mustGet(executionId);
    const held = new Set(this.deps.bundle.listReceipts().map((f) => f.replace(/\.json$/, "")));
    const payments = this.paymentsFor(execution, this.approvalOf(execution));
    const fetched: string[] = [];
    const sealMismatches: string[] = [];
    for (const outcome of execution.outcomes) {
      const payment = payments[outcome.index];
      if (outcome.status !== "settled" || !outcome.receipt_id || held.has(outcome.receipt_id) || !payment) continue;
      const mismatch = await this.saveReceipt(execution.id, outcome.receipt_id, payment);
      if (mismatch) sealMismatches.push(mismatch);
      fetched.push(outcome.receipt_id);
    }
    if (sealMismatches.length > 0) throw new ReceiptSealMismatchError(execution.id, sealMismatches);
    return fetched;
  }

  // ---- section 10: resume and reconcile ---------------------------------

  /**
   * An execution left in `executing` is reconciled, NEVER dispatched. Each
   * attempt without an outcome is looked up on the rail; a recorded settled
   * or failed answer is taken, and anything else (in flight, uncertain,
   * unknown) leaves the execution in `executing` with an `execution.uncertain`
   * event, for a human. "Unknown" is not "never sent": on the real rail a
   * receipt is indexed seconds after settlement (~43 s measured on Celcoin).
   */
  async reconcile(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "executing") return execution;
    const payments = this.paymentsFor(execution, this.approvalOf(execution));
    const outbox = this.deps.store.getOutbox(execution.idempotency_key);
    if (outbox?.status === "pending") {
      return this.leaveUnresolved(execution as Execution<"executing">, "outbox pending: nothing was ever sent; `resume` dispatches it, reconcile does not");
    }

    const outcomes: ItemOutcome[] = [...execution.outcomes];
    const sealMismatches: string[] = [];
    let unresolved: string | undefined;
    for (const [index, payment] of payments.entries()) {
      const prior = outcomes.find((o) => o.index === index);
      // Settled and failed are final. An accepted receivable is looked at again: its payer may have acted.
      if (prior && prior.status !== "accepted") continue;
      const seen = await this.deps.rail.lookup(payment.attempt_id, payment, prior?.transaction_id);
      const found = seen ? seen.status : "absent";
      const stored = this.deps.store.appendEvent({
        run_id: this.deps.runId,
        execution_id: execution.id,
        // A poll that sees the same thing twice logs it once; a change in what it sees is a new line.
        ...(prior ? { event_id: `reconcile:${payment.attempt_id}:${found}:${seen && seen.status === "accepted" ? `${seen.instrument.status}:${seen.instrument.payable}` : ""}` } : {}),
        type: "rail.reconcile",
        payload: { attempt_id: payment.attempt_id, found },
        at: this.clock().toISOString(),
      });
      if (stored) this.deps.bundle.event({ ...stored, actor: this.agentActor });
      if (!seen || seen.status === "uncertain" || seen.status === "in_flight") {
        if (prior) continue; // the receivable is known to exist; the rail just did not answer this time
        // One attempt the rail cannot answer for does not stop us learning
        // about the others. A lookup moves no money, so there is nothing to
        // be careful about here, and stopping would mean a later attempt's
        // settlement is never recorded at all.
        unresolved ??= `attempt ${payment.attempt_id}: ${seen ? seen.status : "unknown to the rail"}; a human decides, nothing is re-sent`;
        continue;
      }
      const replace = (outcome: ItemOutcome) => {
        const at = outcomes.findIndex((o) => o.index === index);
        if (at >= 0) outcomes[at] = outcome;
        else outcomes.push(outcome);
      };
      if (seen.status === "accepted") {
        replace({ index, attempt_id: payment.attempt_id, status: "accepted", transaction_id: seen.transaction_id, instrument: seen.instrument });
        this.recordInstrument(execution.id, payment.attempt_id, seen.transaction_id, seen.instrument);
        continue;
      }
      if (seen.status === "failed") {
        replace({ index, attempt_id: payment.attempt_id, status: "failed", code: seen.code, error: `${seen.code}: ${seen.message}`, ...(seen.held ? { held: seen.held } : {}) });
        continue;
      }
      // No `replayed` here, whatever the rail said. A lookup IS a second
      // presentation of an attempt this execution already sent, so on the API
      // every settled lookup answers `idempotent_replay`, including the one
      // whose payment was this execution's own. The mark would say "someone
      // else paid" about a payment nobody can attribute from here.
      replace({ index, attempt_id: payment.attempt_id, status: "settled", transaction_id: seen.transaction_id, ...(seen.receipt_id ? { receipt_id: seen.receipt_id } : {}) });
      const mismatch = await this.ingestSettlement(execution, index, payment, seen.receipt_id, prior ? CHARGE_PAID : PAYMENT_SUCCEEDED);
      if (mismatch) sealMismatches.push(mismatch);
    }
    const updated: Execution<"executing"> = { ...(execution as Execution<"executing">), outcomes };
    const reconciled = unresolved ? this.leaveUnresolved(updated, unresolved) : this.close(updated, payments.length);
    if (sealMismatches.length > 0) throw new ReceiptSealMismatchError(execution.id, sealMismatches);
    return reconciled;
  }

  /**
   * `resume` only: dispatches the attempts of an `executing` execution whose
   * outbox row is still `pending`. `pending` flips to `sent` before the first
   * rail call, so a `pending` row proves nothing ever left; anything `sent`
   * goes through `reconcile()` instead and is never re-sent.
   */
  async resumePending(executionId: string): Promise<Execution> {
    const execution = this.mustGet(executionId);
    if (execution.state !== "executing") return execution;
    const outbox = this.deps.store.getOutbox(execution.idempotency_key);
    if (outbox?.status !== "pending") return this.reconcile(executionId);
    this.record("rail.resume", execution.id, { detail: "outbox pending: nothing was ever sent; dispatching once under the same attempt ids" });
    return this.dispatch(execution as Execution<"executing">, this.paymentsFor(execution, this.approvalOf(execution)));
  }

  /** Time-based exits: an open execution past its approval TTL closes as `expired`. */
  expireStale(): Execution[] {
    const now = this.clock();
    const ttl = this.deps.guardrails.approval_ttl_minutes * 60_000;
    const out: Execution[] = [];
    for (const execution of this.deps.store.listExecutions({ state: ["awaiting_approval", "approved"] })) {
      const opened = new Date(execution.updated_at).getTime();
      if (now.getTime() - opened <= ttl) continue;
      out.push(this.persist(transition(execution as Execution<"awaiting_approval">, "expired", { at: now.toISOString(), actor: this.agentActor, reason: "approval_expired", detail: `no decision within ${this.deps.guardrails.approval_ttl_minutes} minutes` })));
    }
    return out;
  }

  /**
   * An event arriving from outside (a trigger, a webhook): deduplicated by
   * id, applied to the ONE attempt it names, and the execution closes only
   * when every attempt has its outcome. `paid` before `created` is fine;
   * `paid` twice settles once.
   */
  ingestExternalEvent(event: { event_id: string; type: string; attempt_id?: string; transaction_id?: string; at?: string }): { applied: boolean; reason: string } {
    const located = this.locateAttempt(event);
    if (!located) return { applied: false, reason: event.attempt_id || event.transaction_id ? "unknown attempt" : "event names no attempt_id and no transaction_id" };
    const { row, attemptId } = located;
    const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: row.execution_id, event_id: event.event_id, type: event.type, payload: { ...event, attempt_id: attemptId }, at: event.at ?? this.clock().toISOString() });
    if (!stored) return { applied: false, reason: "duplicate event id" };
    this.deps.bundle.event({ ...stored, actor: this.agentActor });
    const execution = this.mustGet(row.execution_id);
    if (isTerminal(execution.state)) return { applied: false, reason: `execution already ${execution.state}` };
    if (execution.state !== "executing") return { applied: false, reason: `execution is ${execution.state}; the rail event cannot move it` };
    const attempts = (row.payload as { attempts: string[] }).attempts;
    const index = attempts.indexOf(attemptId);
    const prior = execution.outcomes.find((o) => o.index === index);
    // Settled and failed are final. An accepted receivable is exactly what a `commerce.charge.*` event decides.
    if (prior && prior.status !== "accepted") return { applied: false, reason: "attempt already has an outcome" };

    const carry = prior ? { ...(prior.transaction_id ? { transaction_id: prior.transaction_id } : {}) } : {};
    let outcome: ItemOutcome;
    switch (event.type) {
      case PAYMENT_SUCCEEDED:
        outcome = { index, attempt_id: attemptId, status: "settled", ...carry };
        break;
      case CHARGE_PAID:
        // The paid receivable is its own record on the API; `collectReceipts()` fetches it into the bundle.
        outcome = { index, attempt_id: attemptId, status: "settled", ...carry, ...(prior?.transaction_id ? { receipt_id: prior.transaction_id } : {}) };
        break;
      case PAYMENT_FAILED:
        outcome = { index, attempt_id: attemptId, status: "failed", code: "rail_failed", error: `event ${event.event_id}` };
        break;
      case CHARGE_EXPIRED:
        outcome = { index, attempt_id: attemptId, status: "failed", code: "charge_expired", error: `charge_expired: event ${event.event_id}`, ...carry };
        break;
      case CHARGE_CANCELLED:
        outcome = { index, attempt_id: attemptId, status: "failed", code: "charge_cancelled", error: `charge_cancelled: event ${event.event_id}`, ...carry };
        break;
      default:
        return { applied: false, reason: `event type ${event.type} moves nothing` };
    }

    const outcomes = execution.outcomes.filter((o) => o.index !== index).concat(outcome).sort((a, b) => a.index - b.index);
    const closed = this.close({ ...(execution as Execution<"executing">), outcomes }, attempts.length);
    return { applied: true, reason: closed.state === "executing" ? `attempt recorded; ${closed.detail}` : closed.state };
  }

  /** An event names our attempt id, or the rail's transaction id we recorded when the attempt was accepted. */
  private locateAttempt(event: { attempt_id?: string; transaction_id?: string }): { row: ReturnType<StateStore["listOutbox"]>[number]; attemptId: string } | undefined {
    const rows = this.deps.store.listOutbox();
    if (event.attempt_id) {
      const attemptId = event.attempt_id;
      const row = rows.find((o) => ((o.payload as { attempts?: string[] }).attempts ?? []).includes(attemptId));
      return row ? { row, attemptId } : undefined;
    }
    if (event.transaction_id) {
      for (const row of rows) {
        const execution = this.deps.store.getExecution(row.execution_id);
        const hit = execution?.outcomes.find((o) => o.transaction_id === event.transaction_id);
        if (hit) return { row, attemptId: hit.attempt_id };
      }
    }
    return undefined;
  }

  // ---- the channel's small writes -----------------------------------------

  /** A line in the event log written by the channel (a message to the person, a sandbox payer call). Never a transition. */
  note(type: string, executionId: string | null, payload: Record<string, unknown>): void {
    this.record(type, executionId, payload);
  }

  /**
   * Once-only presentation: true the first time a given attempt's instrument
   * is marked shown, false afterwards, across restarts (it is a cursor in
   * state.db, not memory). The debtor sees each QR once.
   */
  markShown(executionId: string, attemptId: string): boolean {
    const key = `shown:${executionId}:${attemptId}`;
    if (this.deps.store.getCursor(key)) return false;
    this.deps.store.setCursor(key, this.clock().toISOString());
    return true;
  }

  /** Once-only message per execution outcome, same mechanism. */
  markTold(executionId: string, outcome: string): boolean {
    const key = `told:${executionId}:${outcome}`;
    if (this.deps.store.getCursor(key)) return false;
    this.deps.store.setCursor(key, this.clock().toISOString());
    return true;
  }

  /**
   * A durable claim for work whose unit is bigger than one execution: a batch
   * line, a scheduled instruction. `claimed` reads which execution covers a
   * key, `claim` records it. Same cursor table as `markShown`, which is this
   * with a boolean answer.
   *
   * It exists because a tool handler's only durable surface is this engine,
   * and a batch that must not pay the same payee twice across runs has to
   * remember which execution already covers each line. What a held claim
   * MEANS is the kit's to decide: the engine records the pairing and reads
   * nothing into it, because "settled, so skip" and "denied, so retry" are
   * the batch's rules and not the state machine's.
   */
  claimed(key: string): string | undefined {
    return this.deps.store.getCursor(`claim:${key}`);
  }

  claim(key: string, executionId: string): void {
    this.deps.store.setCursor(`claim:${key}`, executionId);
  }

  // ---- reads --------------------------------------------------------------

  get(executionId: string): Execution | undefined {
    return this.deps.store.getExecution(executionId);
  }

  list(filter: { state?: ExecutionState | ExecutionState[] } = {}): Execution[] {
    return this.deps.store.listExecutions({ ...filter, mandate_id: this.deps.mandate.id });
  }

  /**
   * The items `draft()` would build from these proposals, resolved against
   * the mandate and WITHOUT the validation that refuses one. It exists for a
   * caller that must hash a whole list before it drafts any of it — a batch
   * computing its `batch_hash` — and it does not throw on purpose: a line the
   * core will refuse is still a line of the presented list, and dropping it
   * from the hash would make a batch holding a broken line hash the same as
   * the shorter batch without it, which is the hole `batch_hash` closes.
   *
   * It resolves nothing the draft will not resolve identically, which is what
   * makes the hash computed here the hash the drafts below carry.
   */
  preview(items: readonly ProposedItem[]): ExecutionItem[] {
    return items.map((p) => this.previewItem(p));
  }

  // ---- helpers ------------------------------------------------------------

  /**
   * Section 4.7, fail-closed: `executing` is reached on `active` and on
   * nothing else. A source that cannot answer (a failed read, a status this
   * code does not know, an exception) is `mandate_status_unavailable`, never
   * "assume active". An expired mandate closes the execution as `expired`;
   * the other refusals close it as `denied`.
   */
  private async mandateGate(): Promise<{ reason: ExecutionReason; detail: string; to: "denied" | "expired" } | undefined> {
    const { mandate } = this.deps;
    let report: MandateStatusReport;
    try {
      report = await this.deps.status.check(mandate.id);
    } catch (err) {
      return { to: "denied", reason: "mandate_status_unavailable", detail: `the status of mandate ${mandate.id} could not be read (${err instanceof Error ? err.message : String(err)}); nothing executes until it can` };
    }
    if (report.org_paused) return { to: "denied", reason: "org_paused", detail: "the organization paused every mandate (kill switch)" };
    switch (report.status) {
      case "revoked":
        return { to: "denied", reason: "mandate_revoked", detail: `mandate ${mandate.id} was revoked (source: ${report.source})` };
      case "paused":
        return { to: "denied", reason: "mandate_paused", detail: `mandate ${mandate.id} is paused (source: ${report.source})` };
      case "expired":
        return { to: "expired", reason: "mandate_expired", detail: `mandate ${mandate.id} expired at ${mandate.expires_at} (source: ${report.source})` };
      case "active":
        if (mandateExpired(mandate, this.clock())) return { to: "expired", reason: "mandate_expired", detail: `mandate ${mandate.id} expired at ${mandate.expires_at}` };
        return undefined;
      default:
        return { to: "denied", reason: "mandate_status_unavailable", detail: `the status of mandate ${mandate.id} could not be read (${report.detail ?? "no detail"}); nothing executes until it can` };
    }
  }

  private resolveItem(proposed: ProposedItem): ExecutionItem {
    const amount = Math.trunc(proposed.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error(`amount must be a positive integer in minor units, got ${proposed.amount}`);
    if (proposed.due_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(proposed.due_date)) throw new Error(`due_date must be YYYY-MM-DD, got ${proposed.due_date}`);
    return this.previewItem(proposed);
  }

  private previewItem(proposed: ProposedItem): ExecutionItem {
    const known = resolveBeneficiary(this.deps.mandate, proposed.payee);
    return {
      ...(known ? { alias: known.alias } : {}),
      beneficiary: known?.name ?? proposed.payee,
      payee: known?.payee ?? proposed.payee,
      amount: Math.trunc(proposed.amount),
      currency: this.deps.mandate.currency,
      ...(proposed.description ? { description: proposed.description } : {}),
      ...(proposed.due_date ? { due_date: proposed.due_date } : {}),
    };
  }

  /**
   * The attempts of an execution. Each carries the quote of the SAME line of
   * the approval artifact — what was approved, not what the execution says
   * now — so a line that drifted after approval is a quote that disagrees,
   * refused before the call. Each also carries the artifact's hashes, which
   * the API seals into the receipt (OPEN_QUESTIONS §3): the artifact is fixed
   * per execution, so a reconcile presents the same approval the first
   * dispatch did, and a batch line's hashes are the same on every machine.
   */
  private paymentsFor(execution: Execution, artifact: ApprovalArtifact): RailPayment[] {
    return execution.items.map((item, index) => {
      // A batch line is the same attempt, with the same quote, on every run of the same list, wherever it runs (§39c); anything else is its execution's own.
      const quote = quoteFromApproval(artifact, index, this.deps.mandate.purpose, { stable: execution.batch !== undefined });
      return {
        attempt_id: execution.batch
          ? batchAttemptId(execution.mandate.id, execution.batch, index, execution.attempt_generations?.[index] ?? 0)
          : `att_${execution.idempotency_key.slice(4)}_${index}`,
        mandate_id: execution.mandate.id,
        amount_minor: item.amount,
        currency: item.currency,
        payee: item.payee,
        beneficiary: item.beneficiary,
        purpose: this.deps.mandate.purpose,
        agent_id: this.deps.mandate.agent_id,
        consumer_id: this.deps.mandate.consumer_id,
        ...(item.description ? { description: item.description } : {}),
        ...(item.due_date ? { due_date: item.due_date } : {}),
        ...(quote ? { quote } : {}),
        approval: spendApprovalOf(artifact),
        actor: this.agentActor,
      };
    });
  }

  private approvalOf(execution: Execution): ApprovalArtifact {
    const artifact = execution.approval_id ? this.deps.store.getApproval(execution.approval_id) : undefined;
    if (!artifact) throw new Error(`execution ${execution.id} is ${execution.state} without an approval artifact`);
    return artifact;
  }

  private withoutApproval(execution: Execution<"approved">): Execution<"approved"> {
    const { approval_id: _stale, ...rest } = execution;
    return rest as Execution<"approved">;
  }

  /** Settled, in flight or awaiting a decision under this mandate inside the cap window, excluding the execution being judged. */
  private committedInWindow(now: Date, excludeId: string): number {
    const start = windowStart(this.deps.mandate, now).getTime();
    return this.list({ state: WINDOW_STATES })
      .filter((e) => e.id !== excludeId && new Date(e.created_at).getTime() >= start)
      .reduce((sum, e) => sum + e.total, 0);
  }

  private knownPayees(): Set<string> {
    const out = new Set<string>();
    for (const e of this.list({ state: "settled" })) for (const i of e.items) out.add(i.payee);
    return out;
  }

  /**
   * What the agent ran ALONE per payee inside the velocity window: mandate-mode
   * executions the allowance approved without a human. A payment a human
   * approved is not fractioning, so it does not count against the threshold.
   */
  private recentByPayee(now: Date, excludeId: string): Map<string, number> {
    const out = new Map<string, number>();
    const hours = this.deps.guardrails.velocity?.window_hours;
    if (!hours) return out;
    const since = now.getTime() - hours * 3_600_000;
    for (const e of this.list({ state: ["approved", "executing", "settled"] })) {
      if (e.id === excludeId || e.mode !== "mandate" || e.escalation !== undefined) continue;
      if (new Date(e.created_at).getTime() < since) continue;
      for (const i of e.items) out.set(i.payee, (out.get(i.payee) ?? 0) + i.amount);
    }
    return out;
  }

  private storeApproval(artifact: ApprovalArtifact): void {
    this.deps.store.saveApproval(artifact);
    this.deps.bundle.approval(artifact);
    this.record("approval.created", artifact.execution_id, { approval_id: artifact.approval_id, approver: artifact.approver, items_hash: artifact.items_hash, batch: artifact.batch ?? null, ...(artifact.composition ? { composition: artifact.composition } : {}), escalation: artifact.escalation ?? null });
  }

  private persist<S extends ExecutionState>(execution: Execution<S>): Execution<S> {
    this.deps.store.saveExecution(execution);
    const last = execution.history[execution.history.length - 1];
    if (last) {
      const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: execution.id, type: "execution.transition", payload: last, at: last.at });
      if (stored) this.deps.bundle.event({ ...stored, actor: last.actor });
    }
    return execution;
  }

  private record(type: string, executionId: string | null, payload: Record<string, unknown>): void {
    const stored = this.deps.store.appendEvent({ run_id: this.deps.runId, execution_id: executionId, type, payload, at: this.clock().toISOString() });
    if (stored) this.deps.bundle.event({ ...stored, actor: this.agentActor });
  }

  private mustGet(executionId: string): Execution {
    const execution = this.deps.store.getExecution(executionId);
    if (!execution) throw new Error(`unknown execution ${executionId}`);
    return execution;
  }
}

/**
 * A batch binding is the kit's to compute and the core's to refuse when it
 * cannot be true. `index` outside `count`, or a `count` of zero, would let a
 * bundle say "line 5 of 3" and make the "N of M" an artifact reader sees
 * meaningless, so it is rejected where the execution is minted rather than
 * carried into the signature.
 */
function assertBatchBinding(batch: ExecutionBatch): void {
  if (!batch.ref.trim()) throw new Error("batch.ref must name the batch");
  if (!batch.batch_hash.trim()) throw new Error("batch.batch_hash must be the hash of the presented lines");
  if (!Number.isInteger(batch.count) || batch.count < 1) throw new Error(`batch.count must be a positive integer, got ${batch.count}`);
  if (!Number.isInteger(batch.index) || batch.index < 0 || batch.index >= batch.count) {
    throw new Error(`batch.index must be a position inside the batch (0..${batch.count - 1}), got ${batch.index}`);
  }
}

/** A composition binding is the kit's to compute and the core's to refuse when it cannot be true. */
function assertCompositionBinding(composition: ExecutionComposition): void {
  if (!composition.ref.trim()) throw new Error("composition.ref must name what was composed");
  if (!/^sha256:[0-9a-f]{64}$/.test(composition.composition_hash)) throw new Error("composition.composition_hash must be the compositionHash of the resolved lines");
  if (!Number.isInteger(composition.line_count) || composition.line_count < 1) throw new Error(`composition.line_count must be a positive integer, got ${composition.line_count}`);
}

/**
 * What the rail answered about one attempt, as the bundle records it: the
 * identifiers a reader follows the money by, and never `raw`, which carries
 * whatever the provider chose to echo back.
 */
function railAnswer(outcome: RailOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "accepted":
      return { transaction_id: outcome.transaction_id, sandbox: outcome.sandbox };
    case "settled":
      return { transaction_id: outcome.transaction_id, receipt_id: outcome.receipt_id, money_moved: outcome.money_moved, sandbox: outcome.sandbox, ...(outcome.replayed ? { idempotent_replay: true } : {}) };
    case "failed":
      return { code: outcome.code, message: outcome.message, ...(outcome.spent ? { spent: true } : {}), ...(outcome.held ? { held: outcome.held } : {}) };
    default:
      return { code: outcome.code, message: outcome.message };
  }
}

/** The failed outcome an execution closes on. An ambiguous receivable outranks any other failure: it is the one outcome that must be reconciled rather than issued again. */
function decisiveFailure(outcomes: readonly ItemOutcome[]): ItemOutcome | undefined {
  return outcomes.find((o) => o.status === "failed" && o.code === "charge_reference_ambiguous") ?? outcomes.find((o) => o.status === "failed");
}

/** What the rail answered, verbatim: the code and message the API sent, not only `rail_failed` or `rail_uncertain` (#50). */
export interface RailError {
  /** `failed`: the answer the execution closed on. `uncertain`: an answer that left an attempt's outcome unknown. */
  outcome: "failed" | "uncertain";
  attempt_id: string;
  code: string;
  message: string | null;
}

/**
 * The rail's own answer behind a failure, for `--json` and the terminal. The
 * reason (`rail_failed`) says WHICH gate closed the execution; this says what
 * the API said, so a first failure explains itself — `insufficient_funds` on
 * an unfunded test wallet reads as that, not as a generic refusal. `null` when
 * nothing failed and nothing was left unknown. A 5xx is not a failure — the
 * money may have moved — so `provider_error` comes back as `uncertain`, with
 * the API's words, while the execution stays open for reconciliation. An
 * outcome stored before the message was kept carries only `code: message` in
 * `error`, and that is what is returned.
 */
export function railErrorOf(execution: Pick<Execution, "outcomes" | "uncertain_answers">): RailError | null {
  const failed = decisiveFailure(execution.outcomes);
  if (failed?.code !== undefined) return { outcome: "failed", attempt_id: failed.attempt_id, code: failed.code, message: failed.message ?? failed.error ?? null };
  const pending = (execution.uncertain_answers ?? []).find((a) => !execution.outcomes.some((o) => o.attempt_id === a.attempt_id));
  return pending ? { outcome: "uncertain", attempt_id: pending.attempt_id, code: pending.code, message: pending.message } : null;
}

/**
 * Settled, and every settled attempt was answered from the rail's record of
 * an earlier presentation this execution never made: the money moved, and
 * this execution did not move it. `dispatch` is the only writer of the mark,
 * so a report can say "paid by this run" of everything else it calls settled.
 */
export function isReplayedSettlement(execution: Pick<Execution, "state" | "outcomes">): boolean {
  const settled = execution.outcomes.filter((o) => o.status === "settled");
  return execution.state === "settled" && settled.length > 0 && settled.every((o) => o.replayed === true);
}

/**
 * A reason, or a rail code, that closes a payment without anything having
 * failed: nobody paid the charge in time, the charge was withdrawn, or the
 * organization pressed the kill switch. It reads with `denied` and `expired`,
 * not with a rail failure, in every count and report.
 */
const DECLINED_REASONS: readonly string[] = ["charge_expired", "charge_cancelled", "org_paused"];

export function isDeclinedReason(reason: string | null | undefined): boolean {
  return typeof reason === "string" && DECLINED_REASONS.includes(reason);
}

/** The approval link a receipt sealed is the one a spend sent: the same hashes, in either spelling of the `sha256:` prefix. */
function sealsApproval(sealed: SealedSpendApproval | null, sent: SpendApproval): boolean {
  return sealed !== null && sameApprovalHash(sealed.items_hash, sent.items_hash) && sameApprovalHash(sealed.batch_hash, sent.batch_hash ?? null);
}

/**
 * A payment settled and the receipt CodeSpar sealed for it names a different
 * payee, or none, or seals another approval than the one the spend sent.
 * Raised after the execution's outcome is saved, never instead of it: the
 * rail's answer is the record of where the money went, and this error is
 * about the evidence. Not a warning, because a receipt that does not name
 * what was paid proves nothing about that payment.
 */
export class ReceiptSealMismatchError extends Error {
  constructor(
    readonly executionId: string,
    readonly mismatches: string[],
  ) {
    super(`execution ${executionId}: the sealed receipt does not seal what was paid — ${mismatches.join("; ")}`);
    this.name = "ReceiptSealMismatchError";
  }
}
