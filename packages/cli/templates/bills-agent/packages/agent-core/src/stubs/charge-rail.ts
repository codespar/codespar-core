/**
 * STUB receivable rail. The deterministic stand-in for `POST /v1/charges`
 * plus the sandbox payer, so the collections scenarios, the adversarial
 * suite and the restart test run offline. Every issuance is persisted in
 * state.db before the outcome is returned, so a process killed right after
 * "the charge was issued" finds it again on `resume`.
 *
 * The fixture payer lives in the lookups: the first look after issuance
 * finds the instrument registered (a cobranca com vencimento answers
 * PROCESSING at create and PENDING once the clearing house has it), the
 * second look finds what the payer did: paid (default), let it expire, or
 * nothing yet. With a real key the scenario runner calls the sandbox pay
 * route instead; this file never talks to the network.
 */
import { sha256Hex } from "../hash.js";
import type { PaymentRail, RailLookup, RailOutcome, RailPayment, RailReceipt } from "../rail.js";
import type { StateStore } from "../state/store.js";
import type { Actor, ChargeInstrument } from "../types.js";

export type StubPayerBehaviour = "pays" | "expires" | "never";

export interface StubChargeRailOptions {
  clock?: () => Date;
  /** What the fixture payer does with a receivable, once it is payable. */
  payer?: StubPayerBehaviour;
  /** Debtor documents the issuer refuses (`failed` issuance), to script a partial failure. */
  refusePayees?: string[];
  /** Attempt ids whose create answers `uncertain` once (the issuer's answer was lost); the reservation still exists and a later look finds it. */
  uncertainOnce?: string[];
  /** Test hook: called after the issuance is persisted and before the outcome is returned. */
  afterDispatch?: (attemptId: string) => void;
}

interface PayerState {
  looks: number;
  fate: StubPayerBehaviour;
}

const CURSOR = (attemptId: string) => `stub-charge-payer:${attemptId}`;

export class StubChargeRail implements PaymentRail {
  readonly name = "stub-charge" as const;
  private readonly clock: () => Date;
  private fate: StubPayerBehaviour;
  private readonly uncertainPending: Set<string>;
  /** How many NEW receivables pay() issued. */
  issueCount = 0;

  constructor(
    private readonly store: StateStore,
    private readonly options: StubChargeRailOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.fate = options.payer ?? "pays";
    this.uncertainPending = new Set(options.uncertainOnce ?? []);
  }

  /** Changes what the fixture payer does with the receivables issued from now on. */
  setPayer(behaviour: StubPayerBehaviour): void {
    this.fate = behaviour;
  }

  /** Scripts the payer for ONE already-issued receivable (a scenario that pays or expires a specific parcel). */
  decide(attemptId: string, behaviour: StubPayerBehaviour): void {
    const state = this.payerState(attemptId);
    this.savePayerState(attemptId, { looks: state?.looks ?? 0, fate: behaviour });
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    const existing = this.store.stubRailGet(payment.attempt_id);
    if (existing) return existing.outcome as RailOutcome;

    if (this.uncertainPending.has(payment.attempt_id)) {
      this.uncertainPending.delete(payment.attempt_id);
      // The issuer took the create and the answer was lost: the reservation exists, so a later lookup finds it.
      this.persistIssued(payment, "PROCESSING", false);
      return { status: "uncertain", code: "issuance_unconfirmed", message: "stub: the issuer's answer to the create was lost; the key is reserved" };
    }

    const at = this.clock().toISOString();
    if (this.options.refusePayees?.includes(payment.payee)) {
      const outcome: RailOutcome = { status: "failed", code: "issuer_refused", message: `stub: issuer refused a charge to ${payment.payee}` };
      const { actor: _actor, ...request } = payment;
      this.store.stubRailPut(payment.attempt_id, request, outcome, at);
      this.options.afterDispatch?.(payment.attempt_id);
      return outcome;
    }
    const outcome = this.persistIssued(payment, "PROCESSING", false);
    this.options.afterDispatch?.(payment.attempt_id);
    return outcome;
  }

  async lookup(attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const recorded = this.store.stubRailGet(attemptId);
    if (!recorded) return undefined;
    const outcome = recorded.outcome as RailOutcome;
    if (outcome.status !== "accepted") return outcome;

    const state = this.payerState(attemptId) ?? { looks: 0, fate: this.fate };
    const looks = state.looks + 1;
    this.savePayerState(attemptId, { ...state, looks });

    // First look: the clearing house registered the instrument. It is payable from here.
    if (looks === 1 || !outcome.instrument.payable) {
      return this.update(attemptId, payment, "PENDING", true);
    }
    if (state.fate === "pays") {
      const settled: RailOutcome = {
        status: "settled",
        transaction_id: outcome.transaction_id,
        receipt_id: outcome.transaction_id,
        money_moved: false,
        sandbox: true,
        raw: { stub: true, attempt_id: attemptId, simulated: true, settled_against: "sandbox_fixture", paid_at: this.clock().toISOString() },
      };
      this.replace(attemptId, payment, settled);
      return settled;
    }
    if (state.fate === "expires") {
      const failed: RailOutcome = { status: "failed", code: "charge_expired", message: `stub: the receivable ${outcome.transaction_id} reached its due date unpaid`, raw: { stub: true } };
      this.replace(attemptId, payment, failed);
      return failed;
    }
    return outcome;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    // The paid charge IS the record: found by its receipt id once the payer acted here, or by its charge id when the settlement came by event.
    const sealed = this.store.stubRailFindByReceipt(receiptId) ?? this.store.stubRailFindByTransaction(receiptId);
    if (!sealed) return undefined;
    const req = sealed.request as Omit<RailPayment, "actor">;
    const out = sealed.outcome as Extract<RailOutcome, { status: "settled" | "accepted" }>;
    const raw = out.raw as { paid_at?: string };
    return {
      receipt_id: receiptId,
      kind: "charge",
      state: "paid",
      mandate: { id: req.mandate_id },
      payment: { amount_minor: req.amount_minor, payee: req.payee, attempt_id: req.attempt_id, money_moved: false, sandbox: true, at: raw.paid_at ?? sealed.at },
      chain: null,
      receipt_sig: null,
      actor,
      raw: { stub: true, charge_id: out.transaction_id, simulated: true, settled_against: "sandbox_fixture" },
    };
  }

  private instrument(payment: RailPayment, status: string, payable: boolean, chargeId: string): ChargeInstrument {
    return {
      payable,
      status,
      pix_copy_paste: payable ? `00020126580014br.gov.bcb.pix0136stub-${chargeId}5204000053039865802BR5909CODESPAR6009SAO PAULO62070503***6304STUB` : null,
      boleto_bank_line: payable ? `${sha256Hex(chargeId).replace(/[a-f]/g, "").padEnd(47, "0").slice(0, 47)}` : null,
      boleto_bar_code: payable ? `${sha256Hex(`bar:${chargeId}`).replace(/[a-f]/g, "").padEnd(44, "0").slice(0, 44)}` : null,
      due_date: payment.due_date ?? null,
    };
  }

  private persistIssued(payment: RailPayment, status: string, payable: boolean): Extract<RailOutcome, { status: "accepted" }> {
    const chargeId = `chg_stub_${sha256Hex(payment.attempt_id).slice(0, 16)}`;
    const outcome: Extract<RailOutcome, { status: "accepted" }> = {
      status: "accepted",
      transaction_id: chargeId,
      instrument: this.instrument(payment, status, payable, chargeId),
      sandbox: true,
      raw: { stub: true, attempt_id: payment.attempt_id, issued_at: this.clock().toISOString() },
    };
    const { actor: _actor, ...request } = payment;
    if (this.store.stubRailPut(payment.attempt_id, request, outcome, this.clock().toISOString())) this.issueCount += 1;
    return outcome;
  }

  private update(attemptId: string, payment: RailPayment, status: string, payable: boolean): Extract<RailOutcome, { status: "accepted" }> {
    const recorded = this.store.stubRailGet(attemptId)!;
    const prior = recorded.outcome as Extract<RailOutcome, { status: "accepted" }>;
    const outcome = { ...prior, instrument: this.instrument(payment, status, payable, prior.transaction_id) };
    this.replace(attemptId, payment, outcome);
    return outcome;
  }

  private replace(attemptId: string, payment: RailPayment, outcome: RailOutcome): void {
    const { actor: _actor, ...request } = payment;
    this.store.stubRailReplace(attemptId, request, outcome, this.clock().toISOString());
  }

  private payerState(attemptId: string): PayerState | undefined {
    const raw = this.store.getCursor(CURSOR(attemptId));
    return raw ? (JSON.parse(raw) as PayerState) : undefined;
  }

  private savePayerState(attemptId: string, state: PayerState): void {
    this.store.setCursor(CURSOR(attemptId), JSON.stringify(state));
  }
}
