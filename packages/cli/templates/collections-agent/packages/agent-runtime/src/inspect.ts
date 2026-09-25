/**
 * Section 11: the proof bundle read back as a timeline. A run folder answers
 * "why could the agent pay this", but only to somebody willing to join six
 * files by hand. `inspect` does the join: who proposed what, who approved it
 * and when, under which version of the mandate, every state transition with
 * its actor, which call went out and what the rail answered, and which
 * receipts came back.
 *
 * It reads the bundle and nothing else — no state.db, no network, no kit — so
 * it works on any agent's run, and on a bundle somebody copied to a laptop
 * that has never seen the agent.
 *
 * Masking is the bundle's: `maskPayee` is what wrote the mandate snapshot and
 * the receipts, and it is applied again here to the payees the event log and
 * the approval artifact still hold raw. It is idempotent on its own output, so
 * a value the bundle already masked passes through unchanged. Nothing here
 * un-masks anything, and the conversation is reported as counts, never as
 * text: a debtor's own words are in `transcript.jsonl` and are not this
 * command's to re-publish.
 */
import { maskPayee, type ApprovalArtifact, type ExecutionBatch, type ProofBundle } from "@codespar/agent-core";
import { formatMinor } from "./default-kit.js";

export interface InspectItem {
  beneficiary: string;
  /** Masked exactly as the bundle masks it. */
  payee: string;
  amount_minor: number;
  currency: string;
  description: string | null;
  due_date: string | null;
}

export interface InspectTransition {
  at: string;
  from: string | null;
  to: string;
  actor: string;
  reason: string | null;
  detail: string | null;
}

export interface InspectAttempt {
  attempt_id: string;
  idempotency_key: string | null;
  payee: string | null;
  amount_minor: number | null;
  rail: string | null;
  dispatched_at: string | null;
  /** What the rail said when it was called, and ONLY that: a later settlement does not rewrite the answer it gave. */
  answer: {
    at: string;
    status: string;
    code: string | null;
    message: string | null;
    transaction_id: string | null;
    receipt_id: string | null;
    money_moved: boolean | null;
    sandbox: boolean | null;
  } | null;
  /** The attempt's outcome as last known, from the call, a later look or a settlement event. */
  status: string | null;
  transaction_id: string | null;
  receipt_id: string | null;
  /** What a later look at the same attempt found. `reconcile` never re-sends; it reads. */
  reconciles: Array<{ at: string; found: string }>;
  /** The payable legs of a receivable, as the issuer last registered them. */
  instrument: Array<{ at: string; status: string; payable: boolean; due_date: string | null }>;
}

export interface InspectExecution {
  execution_id: string;
  final_state: string;
  mode: string | null;
  proposed_at: string | null;
  items: InspectItem[];
  total_minor: number | null;
  /** What the model claimed the total was. Recorded, never used to pay. */
  model_claimed_total: number | null;
  /** The batch this execution is one line of, when it is one: which list, and where in it. */
  batch: ExecutionBatch | null;
  approval: {
    approval_id: string;
    approver: ApprovalArtifact["approver"];
    approved_at: string;
    expires_at: string;
    items_hash: string;
    /** The set binding as the ARTIFACT carries it, which is the signed copy. */
    batch: ExecutionBatch | null;
    mandate: { id: string; version: number };
    escalation: { trigger: string; detail: string } | null;
  } | null;
  transitions: InspectTransition[];
  attempts: InspectAttempt[];
  receipts: string[];
  /** Lines that are neither a transition nor a rail call: an uncertain outcome, a resumed dispatch, a total the core overrode. */
  notes: Array<{ at: string; type: string; detail: string }>;
}

export interface InspectReceipt {
  receipt_id: string;
  file: string;
  state: string | null;
  amount_minor: number | null;
  payee: string | null;
  money_moved: boolean | null;
  sandbox: boolean | null;
  at: string | null;
}

/**
 * One batch the run touched, assembled from the `batch_hash` its executions
 * carry. This is what lets a reader see "3 of 4 lines" instead of three
 * timelines with nothing to compare against: `count` is what the list held
 * when it was presented for approval, and everything below is measured
 * against it.
 *
 * Keyed by (ref, batch_hash) and not by ref alone. A bundle that holds two
 * lists under one ref is a bundle where the list changed, and collapsing
 * them into one header would hide exactly the thing `batch_hash` exists to
 * show.
 */
export interface InspectBatch {
  ref: string;
  batch_hash: string;
  /** Lines the list held when it was presented. */
  count: number;
  /** The lines this bundle holds an execution for, by their position in the list. */
  lines: Array<{ index: number; execution_id: string; final_state: string; attested: boolean }>;
  /** How many of the lines carry an approval artifact. The "3" of "3 of 4". */
  attested: number;
  /** Positions of the presented list this bundle holds no execution for at all. */
  missing: number[];
}

export interface InspectReport {
  run: {
    run_id: string;
    agent: string | null;
    mode: string | null;
    rail: string | null;
    mandate_id: string | null;
    mandate_version: number | null;
    started_at: string | null;
    bundle_dir: string;
  };
  mandate: {
    id: string;
    version: number;
    status: string;
    expires_at: string;
    currency: string;
    per_tx_cap_minor: number;
    cap_minor: number;
    periodic_cap: { window: string; cap_minor: number } | null;
    beneficiaries: Array<{ alias: string; name: string; payee: string }>;
  } | null;
  executions: InspectExecution[];
  /** The batches this run's executions belong to. Empty for a run that ran no batch. */
  batches: InspectBatch[];
  /** Events the run holds that belong to no execution: a proposal refused before it was drafted, a tool outside `tools.json`. */
  run_events: Array<{ at: string; type: string; detail: string }>;
  receipts: InspectReceipt[];
  conversation: { turns: number; tool_calls: number; tools: string[]; refused_tools: string[] };
  /** Section 11: `verify.json` is the output of `codespar audit replay`, which is not a registered CLI command. */
  verify: { present: boolean; note: string };
}

export const VERIFY_NOTE =
  "absent by design: verify.json is the output of `codespar audit replay`, which is not a registered command of @codespar/cli, and the spec forbids a second implementation of the hash-chain check (sections 11 and 14.5)";

type Event = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function payload(event: Event): Record<string, unknown> {
  const p = event["payload"];
  return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

/** `agent bills-agent@0.1.0 for usr_x`, `usr_x (person, terminal)`: who acted, in one phrase. */
export function actorLabel(actor: unknown): string {
  if (actor === null || typeof actor !== "object") return "unknown";
  const a = actor as Record<string, unknown>;
  if (a["type"] === "agent") return `agent ${String(a["agent"])} for ${String(a["on_behalf_of"])}`;
  if (a["type"] === "human") return `${String(a["id"])} (person, ${String(a["channel"])})`;
  if (a["type"] === "person") return `${String(a["id"])} (person, ${String(a["channel"])})`;
  if (a["type"] === "mandate") return `the mandate ${String(a["id"])}`;
  return "unknown";
}

function maskMaybe(value: unknown): string | null {
  const s = str(value);
  return s === null ? null : maskPayee(s);
}

/**
 * A payee key also turns up inside free text: an escalation detail names the
 * payee it escalated on, a refusal names the one it refused. Masking the
 * `payee` field alone would leave the same key readable one line below, so
 * every raw payee the bundle holds is replaced by its mask wherever it
 * appears. Longest first, or a key that is a prefix of another masks it twice.
 */
export function redactorFor(rawPayees: Iterable<string>): (value: string | null) => string | null {
  const pairs = [...new Set([...rawPayees].filter((p) => p.length > 0 && p !== "*"))]
    .sort((a, b) => b.length - a.length)
    .map((raw) => [raw, maskPayee(raw)] as const)
    .filter(([raw, masked]) => raw !== masked);
  if (!pairs.length) return (value) => value;
  return (value) => {
    if (value === null) return null;
    let out = value;
    for (const [raw, masked] of pairs) out = out.split(raw).join(masked);
    return out;
  };
}

/** Every raw payee this bundle holds: the drafted items, the rail calls, the settlement events and the approval artifacts. */
function rawPayeesOf(events: Event[], approvals: ApprovalArtifact[]): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    const s = str(value);
    if (s) out.push(s);
  };
  for (const event of events) {
    const p = payload(event);
    push(p["payee"]);
    if (Array.isArray(p["items"])) for (const i of p["items"] as Array<Record<string, unknown>>) push(i?.["payee"]);
  }
  for (const artifact of approvals) for (const i of artifact.items) push(i.payee);
  return out;
}

/**
 * A batch binding as the bundle holds it, refusing anything that is not one.
 * A bundle is a file somebody may have edited, so "line 5 of 3" is read as no
 * binding at all rather than rendered as a count a reader would then trust.
 */
function batchBinding(raw: unknown): ExecutionBatch | null {
  if (raw === null || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const ref = str(b["ref"]);
  const hash = str(b["batch_hash"]);
  const index = num(b["index"]);
  const count = num(b["count"]);
  if (!ref || !hash || index === null || count === null) return null;
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) return null;
  return { ref, batch_hash: hash, index, count };
}

function item(raw: unknown, currency: string): InspectItem {
  const i = (raw ?? {}) as Record<string, unknown>;
  return {
    beneficiary: str(i["beneficiary"]) ?? str(i["alias"]) ?? "unknown",
    payee: maskMaybe(i["payee"]) ?? "unknown",
    amount_minor: num(i["amount"]) ?? 0,
    currency: str(i["currency"]) ?? currency,
    description: str(i["description"]),
    due_date: str(i["due_date"]),
  };
}

function attemptOf(attempts: Map<string, InspectAttempt>, attemptId: string): InspectAttempt {
  const existing = attempts.get(attemptId);
  if (existing) return existing;
  const fresh: InspectAttempt = {
    attempt_id: attemptId,
    idempotency_key: null,
    payee: null,
    amount_minor: null,
    rail: null,
    dispatched_at: null,
    answer: null,
    status: null,
    transaction_id: null,
    receipt_id: null,
    reconciles: [],
    instrument: [],
  };
  attempts.set(attemptId, fresh);
  return fresh;
}

/**
 * The bundle, joined. Every field comes from a file in the run folder; a run
 * that is missing one is reported with nulls rather than refused, because an
 * interrupted run is exactly when somebody wants to look at it.
 */
export function assembleTimeline(bundle: ProofBundle): InspectReport {
  const meta = bundle.readMeta() ?? {};
  const events = bundle.readEvents();
  const approvals = bundle.readApprovals();
  const snapshot = bundle.readMandateSnapshot();
  const currency = str(snapshot?.["currency"]) ?? "BRL";

  const redact = redactorFor(rawPayeesOf(events, approvals));
  const executions = new Map<string, InspectExecution>();
  const attemptsBy = new Map<string, Map<string, InspectAttempt>>();
  const runEvents: InspectReport["run_events"] = [];

  const executionOf = (id: string): InspectExecution => {
    const existing = executions.get(id);
    if (existing) return existing;
    const fresh: InspectExecution = {
      execution_id: id,
      final_state: "unknown",
      mode: null,
      proposed_at: null,
      items: [],
      total_minor: null,
      model_claimed_total: null,
      batch: null,
      approval: null,
      transitions: [],
      attempts: [],
      receipts: [],
      notes: [],
    };
    executions.set(id, fresh);
    attemptsBy.set(id, new Map());
    return fresh;
  };

  for (const event of events) {
    const type = str(event["type"]) ?? "unknown";
    const at = str(event["at"]) ?? "";
    const executionId = str(event["execution_id"]);
    const p = payload(event);

    if (!executionId) {
      const detail = str(p["detail"]) ?? str(p["reason"]) ?? str(event["reason"]) ?? str(event["tool"]) ?? str(event["message"]) ?? "";
      const tool = str(event["tool"]);
      runEvents.push({ at, type, detail: redact(tool ? `${tool}: ${detail || String(event["reason"] ?? "")}` : detail) ?? "" });
      continue;
    }

    const execution = executionOf(executionId);
    const attempts = attemptsBy.get(executionId)!;

    switch (type) {
      case "execution.drafted": {
        execution.proposed_at = at;
        execution.items = Array.isArray(p["items"]) ? (p["items"] as unknown[]).map((i) => item(i, currency)) : [];
        execution.total_minor = num(p["total"]);
        execution.model_claimed_total = num(p["model_claimed_total"]);
        execution.mode = str(p["mode"]);
        execution.batch = batchBinding(p["batch"]);
        break;
      }
      case "execution.transition": {
        const to = str(p["to"]) ?? "unknown";
        execution.transitions.push({ at: str(p["at"]) ?? at, from: str(p["from"]), to, actor: actorLabel(p["actor"] ?? event["actor"]), reason: str(p["reason"]), detail: redact(str(p["detail"])) });
        execution.final_state = to;
        break;
      }
      case "approval.created":
        // The artifact itself is `approval.json`; the event is only the stamp that says when it was written.
        break;
      case "rail.dispatch": {
        const attemptId = str(p["attempt_id"]);
        if (!attemptId) break;
        const attempt = attemptOf(attempts, attemptId);
        attempt.dispatched_at = at;
        attempt.payee = maskMaybe(p["payee"]);
        attempt.amount_minor = num(p["amount"]);
        attempt.rail = str(p["rail"]);
        attempt.idempotency_key = str(p["idempotency_key"]);
        break;
      }
      case "rail.outcome": {
        const attemptId = str(p["attempt_id"]);
        if (!attemptId) break;
        const attempt = attemptOf(attempts, attemptId);
        attempt.answer = {
          at,
          status: str(p["status"]) ?? "unknown",
          code: str(p["code"]),
          message: redact(str(p["message"])),
          transaction_id: str(p["transaction_id"]),
          receipt_id: str(p["receipt_id"]),
          money_moved: bool(p["money_moved"]),
          sandbox: bool(p["sandbox"]),
        };
        attempt.status = attempt.answer.status;
        attempt.transaction_id = attempt.answer.transaction_id ?? attempt.transaction_id;
        attempt.receipt_id = attempt.answer.receipt_id ?? attempt.receipt_id;
        break;
      }
      case "rail.uncertain": {
        const attemptId = str(p["attempt_id"]);
        const attempt = attemptId ? attemptOf(attempts, attemptId) : undefined;
        if (attempt?.answer) {
          attempt.answer.message = redact(str(p["message"])) ?? attempt.answer.message;
          attempt.answer.code = str(p["code"]) ?? attempt.answer.code;
        }
        break;
      }
      case "rail.reconcile": {
        const attemptId = str(p["attempt_id"]);
        if (!attemptId) break;
        const found = str(p["found"]) ?? "unknown";
        const attempt = attemptOf(attempts, attemptId);
        attempt.reconciles.push({ at, found });
        if (found !== "absent" && found !== "unknown") attempt.status = found;
        break;
      }
      case "charge.instrument": {
        const attemptId = str(p["attempt_id"]);
        if (!attemptId) break;
        const attempt = attemptOf(attempts, attemptId);
        attempt.transaction_id = str(p["charge_id"]) ?? attempt.transaction_id;
        attempt.instrument.push({ at, status: str(p["status"]) ?? "unknown", payable: bool(p["payable"]) ?? false, due_date: str(p["due_date"]) });
        break;
      }
      case "receipt.saved": {
        const receiptId = str(p["receipt_id"]);
        if (receiptId && !execution.receipts.includes(receiptId)) execution.receipts.push(receiptId);
        break;
      }
      default: {
        const attemptId = str(p["attempt_id"]);
        if (type.startsWith("commerce.")) {
          // The rail's own settlement event, which may be the ONLY place a receipt id appears (a webhook closed the attempt).
          const receiptId = str(p["receipt_id"]);
          if (attemptId) {
            const attempt = attemptOf(attempts, attemptId);
            attempt.receipt_id = receiptId ?? attempt.receipt_id;
          }
          execution.notes.push({ at, type, detail: [attemptId ? `attempt ${attemptId}` : "", receiptId ? `receipt ${receiptId}` : ""].filter(Boolean).join(" · ") });
          break;
        }
        execution.notes.push({ at, type, detail: redact(str(p["detail"]) ?? str(p["message"]) ?? str(p["reason"]) ?? "") ?? "" });
      }
    }
  }

  for (const artifact of approvals) {
    const execution = executionOf(artifact.execution_id);
    execution.approval = {
      approval_id: artifact.approval_id,
      approver: artifact.approver,
      approved_at: artifact.approved_at,
      expires_at: artifact.expires_at,
      items_hash: artifact.items_hash,
      batch: batchBinding(artifact.batch),
      mandate: artifact.mandate,
      escalation: artifact.escalation ? { trigger: artifact.escalation.trigger, detail: redact(artifact.escalation.detail) ?? "" } : null,
    };
    // A run whose event log was truncated still knows what was approved.
    if (execution.items.length === 0) execution.items = artifact.items.map((i) => item(i, currency));
    if (!execution.batch) execution.batch = batchBinding(artifact.batch);
  }

  for (const [id, attempts] of attemptsBy) executionOf(id).attempts = [...attempts.values()];

  const receipts: InspectReceipt[] = bundle.listReceipts().map((file) => {
    const raw = bundle.readReceipt(file) ?? {};
    const payment = (raw["payment"] ?? {}) as Record<string, unknown>;
    return {
      receipt_id: str(raw["receipt_id"]) ?? file.replace(/\.json$/, ""),
      file: `receipts/${file}`,
      state: str(raw["state"]),
      amount_minor: num(payment["amount_minor"]),
      payee: maskMaybe(payment["payee"]),
      money_moved: bool(payment["money_moved"]),
      sandbox: bool(payment["sandbox"]),
      at: str(payment["at"]),
    };
  });

  const transcript = bundle.readTranscript();
  const toolCalls = transcript.filter((l) => l.kind === "tool_call");
  const refusedTools = transcript.filter((l) => l.kind === "tool_result" && l["refused"] === true).map((l) => String(l["name"]));

  return {
    run: {
      run_id: bundle.runId,
      agent: str(meta["agent"]),
      mode: str(meta["mode"]),
      rail: str(meta["rail"]),
      mandate_id: str(meta["mandate_id"]),
      mandate_version: num(meta["mandate_version"]) ?? num(snapshot?.["version"]),
      started_at: str(meta["started_at"]),
      bundle_dir: bundle.dir,
    },
    mandate: snapshot
      ? {
          id: str(snapshot["id"]) ?? "unknown",
          version: num(snapshot["version"]) ?? 0,
          status: str(snapshot["status"]) ?? "unknown",
          expires_at: str(snapshot["expires_at"]) ?? "unknown",
          currency,
          per_tx_cap_minor: num(snapshot["per_tx_cap_minor"]) ?? 0,
          cap_minor: num(snapshot["cap_minor"]) ?? 0,
          periodic_cap: snapshot["periodic_cap"] && typeof snapshot["periodic_cap"] === "object" ? { window: String((snapshot["periodic_cap"] as Record<string, unknown>)["window"]), cap_minor: Number((snapshot["periodic_cap"] as Record<string, unknown>)["cap_minor"]) } : null,
          beneficiaries: Array.isArray(snapshot["beneficiaries"])
            ? (snapshot["beneficiaries"] as Array<Record<string, unknown>>).map((b) => ({ alias: String(b["alias"]), name: String(b["name"]), payee: maskMaybe(b["payee"]) ?? "unknown" }))
            : [],
        }
      : null,
    executions: [...executions.values()],
    batches: assembleBatches([...executions.values()]),
    run_events: runEvents,
    receipts,
    conversation: {
      turns: transcript.filter((l) => l.kind === "user").length,
      tool_calls: toolCalls.length,
      tools: [...new Set(toolCalls.map((l) => String(l["name"])))],
      refused_tools: [...new Set(refusedTools)],
    },
    verify: { present: bundle.hasVerify(), note: VERIFY_NOTE },
  };
}

/**
 * The batches of a run, from the bindings its executions carry. A line is
 * `attested` when the bundle holds its approval artifact: a line a person
 * DENIED has an execution and no artifact, and a line dropped before it ran
 * has neither, so the two are counted apart and both are visible.
 */
function assembleBatches(executions: InspectExecution[]): InspectBatch[] {
  const batches = new Map<string, InspectBatch>();
  for (const execution of executions) {
    const binding = execution.batch;
    if (!binding) continue;
    const key = `${binding.ref}\u0000${binding.batch_hash}`;
    const entry = batches.get(key) ?? { ref: binding.ref, batch_hash: binding.batch_hash, count: binding.count, lines: [], attested: 0, missing: [] };
    entry.lines.push({ index: binding.index, execution_id: execution.execution_id, final_state: execution.final_state, attested: execution.approval !== null });
    batches.set(key, entry);
  }
  for (const entry of batches.values()) {
    entry.lines.sort((a, b) => a.index - b.index);
    entry.attested = entry.lines.filter((l) => l.attested).length;
    const held = new Set(entry.lines.map((l) => l.index));
    entry.missing = [...Array(entry.count).keys()].filter((i) => !held.has(i));
  }
  return [...batches.values()];
}

// ---- the terminal rendering --------------------------------------------

function clock(at: string | null): string {
  if (!at) return "--:--:--";
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(at);
  return m?.[1] ?? at;
}

function approverLabel(approver: ApprovalArtifact["approver"]): string {
  return approver.type === "person" ? `${approver.id} (person, ${approver.channel})` : `the mandate ${approver.id}`;
}

/** One ordered list of lines per execution: the proposal, the decision, every transition, the call and its answer. */
function executionLines(execution: InspectExecution): Array<{ at: string; label: string; text: string; wrapped: string[] }> {
  const lines: Array<{ at: string; label: string; text: string; wrapped: string[] }> = [];

  if (execution.proposed_at) {
    const wrapped = execution.items.map((i) => `${i.beneficiary} <${i.payee}>  ${formatMinor(i.amount_minor)}${i.description ? `  ${i.description}` : ""}${i.due_date ? `  due ${i.due_date}` : ""}`);
    if (execution.total_minor !== null) {
      wrapped.push(`total ${formatMinor(execution.total_minor)} computed by the core${execution.model_claimed_total !== null ? `; the model said ${formatMinor(execution.model_claimed_total)}` : ""}`);
    }
    lines.push({ at: execution.proposed_at, label: "proposed", text: `${execution.items.length} item(s)${execution.mode ? ` in ${execution.mode} mode` : ""}`, wrapped });
  }

  const approval = execution.approval;
  if (approval) {
    const wrapped = [`${approval.approval_id} · items_hash ${approval.items_hash}`, `under mandate ${approval.mandate.id} v${approval.mandate.version} · the artifact expires ${clock(approval.expires_at)}`];
    if (approval.batch) wrapped.push(`line ${approval.batch.index + 1} of ${approval.batch.count} of batch ${approval.batch.ref} · batch_hash ${approval.batch.batch_hash}`);
    if (approval.escalation) wrapped.push(`escalated by ${approval.escalation.trigger}: ${approval.escalation.detail}`);
    lines.push({ at: approval.approved_at, label: "approved", text: approverLabel(approval.approver), wrapped });
  }

  for (const t of execution.transitions) {
    const suffix = [t.reason ? `reason ${t.reason}` : "", t.detail ?? ""].filter(Boolean).join(" · ");
    lines.push({ at: t.at, label: "state", text: `${t.from ?? "-"} -> ${t.to}  by ${t.actor}`, wrapped: suffix ? [suffix] : [] });
  }

  for (const a of execution.attempts) {
    if (a.dispatched_at) {
      const wrapped = a.idempotency_key ? [`idempotency_key ${a.idempotency_key}`] : [];
      lines.push({ at: a.dispatched_at, label: "call out", text: `${a.attempt_id} -> ${a.rail ?? "rail"}${a.amount_minor !== null ? `  ${formatMinor(a.amount_minor)}` : ""}${a.payee ? ` to ${a.payee}` : ""}`, wrapped });
    }
    const answer = a.answer;
    if (answer) {
      const bits = [answer.transaction_id ? `tx ${answer.transaction_id}` : "", answer.receipt_id ? `receipt ${answer.receipt_id}` : "", answer.money_moved !== null ? `money_moved ${answer.money_moved}` : "", answer.sandbox ? "sandbox" : ""].filter(Boolean);
      const why = [answer.code, answer.message].filter(Boolean).join(": ");
      lines.push({ at: answer.at, label: "rail says", text: `${answer.status}${why ? `  ${why}` : ""}`, wrapped: bits.length ? [bits.join(" · ")] : [] });
    }
    for (const i of a.instrument) lines.push({ at: i.at, label: "instrument", text: `${a.attempt_id}  ${i.status}${i.payable ? ", payable" : ", not payable yet"}${i.due_date ? `, due ${i.due_date}` : ""}`, wrapped: [] });
    for (const r of a.reconciles) lines.push({ at: r.at, label: "look again", text: `${a.attempt_id}  the rail says ${r.found}`, wrapped: [] });
  }

  for (const n of execution.notes) lines.push({ at: n.at, label: n.type.startsWith("commerce.") ? "rail event" : "note", text: `${n.type}${n.detail ? `  ${n.detail}` : ""}`, wrapped: [] });

  return lines.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
}

/**
 * The batch header, in the words a reader needs: how many lines the approved
 * list held, how many of them this bundle attests, and which positions it
 * holds nothing for. "3 of 4 lines attested" is the sentence; the rest of the
 * block says which 3 and which 4th.
 */
export function batchSummary(batch: InspectBatch): string {
  const bits = [`${batch.attested} of ${batch.count} line(s) attested`];
  if (batch.lines.length !== batch.attested) bits.push(`${batch.lines.length} with an execution`);
  if (batch.missing.length) bits.push(`no execution for line(s) ${batch.missing.map((i) => i + 1).join(", ")}`);
  return bits.join(" · ");
}

/** One row per position of the presented list, present in the bundle or not. */
export function batchLineRows(batch: InspectBatch): string[] {
  const byIndex = new Map(batch.lines.map((l) => [l.index, l]));
  return [...Array(batch.count).keys()].map((i) => {
    const line = byIndex.get(i);
    const where = `line ${i + 1} of ${batch.count}`;
    if (!line) return `${where}  — no execution in this bundle: approved as part of this list, and nothing here says it ran`;
    return `${where}  ${line.execution_id}  ${line.final_state}  ${line.attested ? "approval artifact present" : "no approval artifact"}`;
  });
}

/** `execution exe_x — settled` gains ` · folha-2026-10 line 2 of 3` when it is one line of a batch. */
function executionHeading(execution: InspectExecution): string {
  const b = execution.batch;
  return `execution ${execution.execution_id} — ${execution.final_state}${b ? ` · ${b.ref} line ${b.index + 1} of ${b.count}` : ""}`;
}

export function renderText(report: InspectReport): string {
  const out: string[] = [];
  const r = report.run;
  out.push(`${r.run_id}${r.agent ? ` — ${r.agent}` : ""}`);
  out.push(`  mode ${r.mode ?? "?"} · rail ${r.rail ?? "?"} · mandate ${r.mandate_id ?? "?"}${r.mandate_version !== null ? ` v${r.mandate_version}` : ""}${r.started_at ? ` · started ${r.started_at}` : ""}`);
  const m = report.mandate;
  if (m) {
    const caps = [`per payment ${formatMinor(m.per_tx_cap_minor)}`, m.periodic_cap ? `per ${m.periodic_cap.window} ${formatMinor(m.periodic_cap.cap_minor)}` : "", `lifetime ${formatMinor(m.cap_minor)}`].filter(Boolean);
    out.push(`  mandate ${m.status}, expires ${m.expires_at} · ${caps.join(" · ")}`);
    if (m.beneficiaries.length) out.push(`  named payees: ${m.beneficiaries.map((b) => `${b.name} <${b.payee}>`).join(", ")}`);
  }

  for (const batch of report.batches) {
    out.push("");
    out.push(`batch ${batch.ref} — ${batchSummary(batch)}`);
    out.push(`  batch_hash ${batch.batch_hash}`);
    for (const row of batchLineRows(batch)) out.push(`  ${row}`);
  }

  for (const execution of report.executions) {
    out.push("");
    out.push(executionHeading(execution));
    for (const line of executionLines(execution)) {
      out.push(`  ${clock(line.at)}  ${line.label.padEnd(10)}  ${line.text}`);
      for (const w of line.wrapped) out.push(`  ${" ".repeat(8)}  ${" ".repeat(10)}  ${w}`);
    }
  }

  if (report.run_events.length) {
    out.push("");
    out.push("outside any execution");
    for (const e of report.run_events) out.push(`  ${clock(e.at)}  ${e.type.padEnd(10)}  ${e.detail}`);
  }

  out.push("");
  out.push(`receipts (${report.receipts.length})`);
  for (const receipt of report.receipts) {
    const bits = [receipt.state ?? "?", receipt.amount_minor !== null ? formatMinor(receipt.amount_minor) : "", receipt.payee ?? "", receipt.sandbox ? "sandbox" : "", receipt.money_moved === false ? "no money moved" : ""].filter(Boolean);
    out.push(`  ${receipt.receipt_id}  ${bits.join("  ")}`);
    out.push(`    ${receipt.file}`);
  }
  if (!report.receipts.length) out.push("  none");

  out.push("");
  const c = report.conversation;
  out.push(`conversation: ${c.turns} turn(s), ${c.tool_calls} tool call(s)${c.tools.length ? ` (${c.tools.join(", ")})` : ""}${c.refused_tools.length ? ` · refused: ${c.refused_tools.join(", ")}` : ""}`);
  out.push(`verify.json: ${report.verify.present ? "present" : report.verify.note}`);
  return out.join("\n") + "\n";
}

// ---- the static HTML rendering ------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * One file, no network: the CSS is inline, there is no script, and nothing is
 * fetched. A bundle inspected on an air-gapped machine renders the same as on
 * a connected one, which is the whole point of a proof you can hand over.
 */
export function renderHtml(report: InspectReport): string {
  const r = report.run;
  const m = report.mandate;
  const esc = escapeHtml;

  const header = [
    `<h1>${esc(r.run_id)}</h1>`,
    `<p class="lede">${esc(r.agent ?? "unknown agent")} · mode <b>${esc(r.mode ?? "?")}</b> · rail <b>${esc(r.rail ?? "?")}</b> · mandate <b>${esc(r.mandate_id ?? "?")}</b>${r.mandate_version !== null ? ` v${r.mandate_version}` : ""}${r.started_at ? ` · started ${esc(r.started_at)}` : ""}</p>`,
    m
      ? `<p class="lede">mandate ${esc(m.status)}, expires ${esc(m.expires_at)} · per payment ${esc(formatMinor(m.per_tx_cap_minor))}${m.periodic_cap ? ` · per ${esc(m.periodic_cap.window)} ${esc(formatMinor(m.periodic_cap.cap_minor))}` : ""} · lifetime ${esc(formatMinor(m.cap_minor))}</p>`
      : "",
    m && m.beneficiaries.length ? `<p class="lede">named payees: ${m.beneficiaries.map((b) => `${esc(b.name)} <code>${esc(b.payee)}</code>`).join(", ")}</p>` : "",
  ].join("\n");

  // The batch header comes before the timelines it is a header FOR: a reader
  // must know the list held four lines before reading the three that ran.
  const batches = report.batches
    .map((batch) => {
      const rows = batchLineRows(batch)
        .map((row) => `<tr><td>${esc(row)}</td></tr>`)
        .join("\n");
      return `<section><h2>batch ${esc(batch.ref)} <span class="state">${esc(batchSummary(batch))}</span></h2><p class="lede">batch_hash <code>${esc(batch.batch_hash)}</code></p><table>${rows}</table></section>`;
    })
    .join("\n");

  const executions = report.executions
    .map((execution) => {
      const rows = executionLines(execution)
        .map((line) => {
          const extra = line.wrapped.map((w) => `<div class="sub">${esc(w)}</div>`).join("");
          return `<tr><td class="t">${esc(clock(line.at))}</td><td class="k"><span class="tag tag-${esc(line.label.replace(/\s+/g, "-"))}">${esc(line.label)}</span></td><td>${esc(line.text)}${extra}</td></tr>`;
        })
        .join("\n");
      const b = execution.batch;
      const where = b ? `<span class="state">${esc(`${b.ref} line ${b.index + 1} of ${b.count}`)}</span>` : "";
      return `<section><h2>execution ${esc(execution.execution_id)} <span class="state state-${esc(execution.final_state)}">${esc(execution.final_state)}</span> ${where}</h2><table>${rows}</table></section>`;
    })
    .join("\n");

  const runEvents = report.run_events.length
    ? `<section><h2>outside any execution</h2><table>${report.run_events.map((e) => `<tr><td class="t">${esc(clock(e.at))}</td><td class="k">${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join("")}</table></section>`
    : "";

  const receipts = report.receipts.length
    ? `<table>${report.receipts
        .map((receipt) => {
          const bits = [receipt.state ?? "?", receipt.amount_minor !== null ? formatMinor(receipt.amount_minor) : "", receipt.payee ?? "", receipt.sandbox ? "sandbox" : "", receipt.money_moved === false ? "no money moved" : ""].filter(Boolean).join(" · ");
          return `<tr><td class="k"><code>${esc(receipt.receipt_id)}</code></td><td>${esc(bits)}<div class="sub">${esc(receipt.file)}</div></td></tr>`;
        })
        .join("")}</table>`
    : "<p class=\"lede\">none</p>";

  const c = report.conversation;
  const footer = `<p class="lede">conversation: ${c.turns} turn(s), ${c.tool_calls} tool call(s)${c.tools.length ? ` (${esc(c.tools.join(", "))})` : ""}${c.refused_tools.length ? ` · refused: ${esc(c.refused_tools.join(", "))}` : ""}</p><p class="lede">verify.json: ${report.verify.present ? "present" : esc(report.verify.note)}</p><p class="lede">Payees are masked the way the proof bundle masks them. The conversation is reported as counts; its text stays in transcript.jsonl.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.run_id)} — CodeSpar proof bundle</title>
<style>
:root { color-scheme: light dark; --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b63; --line: #e2e2dc; --card: #ffffff; --accent: #2f5d50; }
@media (prefers-color-scheme: dark) { :root { --bg: #16171a; --fg: #e8e8e4; --muted: #9a9a92; --line: #2c2d31; --card: #1d1e22; --accent: #7fc3ae; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { max-width: 980px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
h2 { font-size: 15px; margin: 0 0 10px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
h3 { font-size: 15px; margin: 28px 0 10px; }
.lede { color: var(--muted); margin: 2px 0; font-size: 13px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin: 20px 0; }
table { width: 100%; border-collapse: collapse; }
td { padding: 5px 8px 5px 0; vertical-align: top; border-top: 1px solid var(--line); font-size: 13px; }
tr:first-child td { border-top: 0; }
td.t { width: 78px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: nowrap; }
td.k { width: 120px; white-space: nowrap; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; word-break: break-word; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; color: var(--muted); }
.tag-proposed, .tag-approved { border-color: var(--accent); color: var(--accent); }
.state { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; font-family: ui-sans-serif, system-ui, sans-serif; color: var(--muted); }
.state-settled { border-color: var(--accent); color: var(--accent); }
.state-denied, .state-failed, .state-expired { border-color: #b4552f; color: #b4552f; }
@media (max-width: 620px) { td.t, td.k { width: auto; white-space: normal; } body { padding: 20px 12px 48px; } }
</style>
</head>
<body>
<main>
${header}
${batches}
${executions}
${runEvents}
<section><h2>receipts (${report.receipts.length})</h2>${receipts}</section>
${footer}
</main>
</body>
</html>
`;
}
