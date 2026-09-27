/**
 * STUB rail. A deterministic stand-in for the CodeSpar sandbox so the
 * scenarios, the adversarial suite and the restart test run offline. Every
 * attempt is persisted in state.db before the outcome is returned, which is
 * what lets a process killed right after "the money left" be reconciled on
 * `resume` instead of paying again. A repeat of an attempt id is answered the
 * way the deployed API answers it (ent#1671): replayed when it settled,
 * in flight while the provider is on it, spent when it failed, and refused
 * when the id arrives with a different payment. A stub that simply replayed
 * whatever it held would let a suite pass that the API fails. Receipts here are HMAC-shaped only in
 * form; nothing about them is verifiable by anyone.
 */
import { canonicalJson, sha256Hex } from "../hash.js";
import { checkQuote } from "../quote.js";
import { checkSpendApproval, type PaymentRail, type RailLookup, type RailOutcome, type RailPayment, type RailReceipt } from "../rail.js";
import type { StateStore } from "../state/store.js";
import type { Actor } from "../types.js";

export interface StubRailOptions {
  clock?: () => Date;
  /** Payees the stub refuses, to script a `failed` outcome. */
  refusePayees?: string[];
  /** Attempt ids the stub answers `uncertain` for, once. */
  uncertainOnce?: string[];
  /**
   * Payees whose first presentation answers `uncertain`, the way a timeout
   * does: the provider still took the attempt, so a later lookup finds it.
   * The payee twin of `refusePayees`, for scripting an unknown outcome in the
   * MIDDLE of a multi-item execution, where the attempt ids are not known
   * until the execution exists.
   */
  uncertainPayees?: string[];
  /** Test hook: called after the attempt is persisted and before the outcome is returned. */
  afterDispatch?: (attemptId: string) => void;
  /** Attempt ids whose first lookup answers `in_flight` and whose second lookup finds the provider finished (settled), with no pay() in between. */
  inFlightThenSettled?: string[];
  /**
   * Where the "provider" keeps its books, when that is not the agent's own
   * state file. The real rail is a server two machines share; a test that
   * runs the same batch from two state files points both at one ledger.
   */
  ledger?: StateStore;
}

/** What the stub's books hold for an attempt the "provider" took and has not finished. */
const IN_FLIGHT = { status: "in_flight" } as const;

type Recorded = RailOutcome | typeof IN_FLIGHT;

/**
 * The fields a repeat of an attempt id is compared on, the stub's share of
 * the API's attempt tuple (ent#1671): whose money, how much, to whom, the
 * digest of the quote and the approval the spend carried (ent#1670). Rail
 * and instrument are the API's and have no stub counterpart.
 */
function mismatchedFields(recorded: Omit<RailPayment, "actor">, asked: Omit<RailPayment, "actor">): string[] {
  const out: string[] = [];
  if (recorded.mandate_id !== asked.mandate_id) out.push("mandate");
  if (recorded.amount_minor !== asked.amount_minor) out.push("amount_minor");
  if (recorded.currency !== asked.currency) out.push("currency");
  if (recorded.payee !== asked.payee) out.push("payee");
  if (canonicalJson(recorded.quote ?? null) !== canonicalJson(asked.quote ?? null)) out.push("quote");
  if (canonicalJson(recorded.approval ?? null) !== canonicalJson(asked.approval ?? null)) out.push("approval");
  return out;
}

export class StubRail implements PaymentRail {
  readonly name = "stub" as const;
  private readonly clock: () => Date;
  private readonly uncertainPending: Set<string>;

  private readonly store: StateStore;

  constructor(
    store: StateStore,
    private readonly options: StubRailOptions = {},
  ) {
    this.store = options.ledger ?? store;
    this.clock = options.clock ?? (() => new Date());
    this.uncertainPending = new Set(options.uncertainOnce ?? []);
  }

  private uncertainArmed = false;
  private readonly inFlightSeen = new Set<string>();
  /** Attempts that already gave their one `uncertain`, so a re-presentation behaves normally. */
  private readonly uncertainAnswered = new Set<string>();
  /** How many times pay() reached the point of persisting a NEW attempt. */
  payCount = 0;

  /** The NEXT new attempt answers `uncertain` once, whatever its id; the provider still took it, so a later lookup sees it in flight and then settled. For scenarios that reconcile. */
  armUncertainOnce(): void {
    this.uncertainArmed = true;
  }

  async pay(payment: RailPayment): Promise<RailOutcome> {
    // The same refusal the CodeSpar rail makes before its call, so a scenario exercises it.
    const quoted = checkQuote(payment);
    if (!quoted.ok) return { status: "failed", code: quoted.code, message: `${quoted.detail}; nothing was sent` };
    const approval = checkSpendApproval(payment);
    if (!approval.ok) return { status: "failed", code: approval.code, message: `${approval.detail}; nothing was sent` };
    const { actor: _actor, ...request } = payment;
    const existing = this.store.stubRailGet(payment.attempt_id);
    if (existing) return this.repeat(payment.attempt_id, existing.request as Omit<RailPayment, "actor">, existing.outcome as Recorded, request);

    const uncertainPayee = this.options.uncertainPayees?.includes(payment.payee) === true && !this.uncertainAnswered.has(payment.attempt_id);
    if (this.uncertainArmed || this.uncertainPending.has(payment.attempt_id) || uncertainPayee) {
      // Armed and payee-scripted attempts were TAKEN by the provider, so they are on its books as in flight; `uncertainOnce` never reached it.
      if (this.uncertainArmed || uncertainPayee) this.store.stubRailPut(payment.attempt_id, request, IN_FLIGHT, this.clock().toISOString());
      this.uncertainAnswered.add(payment.attempt_id);
      this.uncertainArmed = false;
      this.uncertainPending.delete(payment.attempt_id);
      return { status: "uncertain", code: "psp_dispatch_uncertain", message: "stub: outcome unknown on first presentation" };
    }

    const at = this.clock().toISOString();
    const outcome: RailOutcome = this.options.refusePayees?.includes(payment.payee)
      ? { status: "failed", code: "psp_dispatch_failed", message: `stub: provider refused payee ${payment.payee}` }
      : settledOutcome(payment.attempt_id, { stub: true, attempt_id: payment.attempt_id, at });
    this.payCount += 1;
    this.store.stubRailPut(payment.attempt_id, request, outcome, at);
    this.options.afterDispatch?.(payment.attempt_id);
    return outcome;
  }

  /**
   * A presentation of an attempt id the books already hold, answered the way
   * the deployed API answers it (ent#1671, #1683), and never by paying:
   * a different payment under the id is `attempt_id_conflict`, checked before
   * the state; a settled one is its ORIGINAL outcome with `idempotent_replay`;
   * one still in flight is `psp_attempt_in_flight`; a failed one is
   * `psp_attempt_conflict`, spent for good.
   */
  private repeat(attemptId: string, recorded: Omit<RailPayment, "actor">, outcome: Recorded, asked: Omit<RailPayment, "actor">): RailOutcome {
    const mismatched = mismatchedFields(recorded, asked);
    if (mismatched.length > 0) {
      return { status: "failed", code: "attempt_id_conflict", message: `stub: attempt ${attemptId} was already used for a different payment (differs in: ${mismatched.join(", ")}); nothing was held or sent`, held: "conflict" };
    }
    switch (outcome.status) {
      case "in_flight":
        return { status: "uncertain", code: "psp_attempt_in_flight", message: `stub: attempt ${attemptId} is claimed and its outcome is not yet recorded` };
      case "settled":
        return { ...outcome, replayed: true, raw: { ...(outcome.raw as Record<string, unknown>), idempotent_replay: true } };
      case "failed":
        return { status: "failed", code: "psp_attempt_conflict", message: `stub: attempt ${attemptId} already failed and moved no money; use a fresh attempt_id`, spent: true };
      default:
        return outcome;
    }
  }

  async lookup(attemptId: string, payment: RailPayment): Promise<RailLookup> {
    const { actor: _actor, ...request } = payment;
    const existing = this.store.stubRailGet(attemptId);
    const recorded = existing?.outcome as Recorded | undefined;
    // Looking up IS presenting again on the real rail, so a recorded attempt answers exactly what a repeat of it answers.
    if (existing && recorded && recorded.status !== "in_flight") return this.repeat(attemptId, existing.request as Omit<RailPayment, "actor">, recorded, request);
    if (this.options.inFlightThenSettled?.includes(attemptId) || recorded?.status === "in_flight") {
      if (!this.inFlightSeen.has(attemptId)) {
        this.inFlightSeen.add(attemptId);
        return { status: "in_flight" };
      }
      // The provider finished on its own; the stub records the outcome as the rail would, without a new dispatch.
      const outcome = settledOutcome(attemptId, { stub: true, attempt_id: attemptId, finished_in_background: true });
      this.store.stubRailReplace(attemptId, existing?.request ?? request, outcome, this.clock().toISOString());
      return outcome;
    }
    return undefined;
  }

  async receipt(receiptId: string, actor: Actor): Promise<RailReceipt | undefined> {
    const sealed = this.store.stubRailFindByReceipt(receiptId);
    if (!sealed) return undefined;
    const req = sealed.request as Omit<RailPayment, "actor">;
    const out = sealed.outcome as Extract<RailOutcome, { status: "settled" }>;
    // Like the API: the payee on the receipt is the one the quote sealed, and none when the spend carried no quote.
    const body = {
      receipt_id: receiptId,
      state: "paid",
      mandate: { id: req.mandate_id },
      // Like the API since ent#1670: the approval the spend carried is sealed and read back, batch_hash null when none was sent.
      chain_version: req.approval ? 4 : 1,
      approval: req.approval ? { items_hash: req.approval.items_hash, batch_hash: req.approval.batch_hash ?? null } : null,
      payment: { amount_minor: req.amount_minor, payee: req.quote?.payee ?? null, attempt_id: req.attempt_id, money_moved: false, sandbox: true, at: sealed.at },
    };
    const chain = `sha256:${sha256Hex(JSON.stringify(req.quote ? { ...body, quote: req.quote } : body))}`;
    return {
      ...body,
      chain,
      receipt_sig: `stub:${sha256Hex(`sig:${chain}`).slice(0, 32)}`,
      // The stub holds no CodeSpar key and must not look as though it did:
      // `npm run verify` answers `unsigned` on a stub receipt, which is the
      // truth about it.
      receipt_sig_ed25519: null,
      receipt_sig_kid: null,
      actor,
      raw: { stub: true, transaction_id: out.transaction_id },
    };
  }
}

function settledOutcome(attemptId: string, raw: Record<string, unknown>): RailOutcome {
  return {
    status: "settled",
    transaction_id: `stubtx_${sha256Hex(attemptId).slice(0, 16)}`,
    receipt_id: `rcpt_stub_${sha256Hex(`receipt:${attemptId}`).slice(0, 16)}`,
    money_moved: false,
    sandbox: true,
    raw,
  };
}
