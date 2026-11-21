import { CodeSpar } from "@codespar/sdk";
import type { CardArgs, CardIssued, CardResult, CardView } from "@codespar/sdk";
import { HttpError } from "../api.js";
import { CliError } from "../config.js";
import { metaToolActions, metaToolEnum } from "../surface.js";
import { info, json, kv, success, table, warn } from "../output.js";
import { resolveMetaInput } from "./meta-input.js";

const TOOL = "codespar_card";

/** Flags every `codespar card <action>` accepts; each action reads its own subset. */
export interface CardFlags {
  currency?: string;
  provider?: string;
  mandateId?: string;
  consumerId?: string;
  holderConsumerId?: string;
  idempotencyKey?: string;
  issuer?: string;
  reason?: string;
  /** Pomelo cardholder identity as JSON (pomelo_brl issue). */
  holder?: string;
}

export interface CardCommandOptions extends CardFlags {
  apiKey: string;
  baseUrl: string;
  project?: string;
  user?: string;
  input?: string;
  inputFile?: string;
  json?: boolean;
}

const FLAG_TO_ARG: ReadonlyArray<[keyof CardFlags, string]> = [
  ["currency", "currency"],
  ["provider", "provider"],
  ["mandateId", "mandate_id"],
  ["consumerId", "consumer_id"],
  ["holderConsumerId", "holder_consumer_id"],
  ["idempotencyKey", "idempotency_key"],
  ["issuer", "issuer"],
  ["reason", "reason"],
];

/**
 * The args for one action: `--input` / `--input-file` JSON first, the flags
 * over it, the positional card id over both. The subcommand names the action;
 * JSON that names another one is refused rather than silently overridden.
 */
export async function buildCardArgs(
  action: string,
  cardId: string | undefined,
  opts: CardFlags & { input?: string; inputFile?: string },
): Promise<CardArgs> {
  const base: Record<string, unknown> =
    opts.input !== undefined || opts.inputFile !== undefined
      ? await resolveMetaInput(opts, `card ${action}`, "{}")
      : {};
  if (base.action !== undefined && base.action !== action) {
    throw new CliError(`card ${action}: the JSON input says action=${String(base.action)}; drop it or run \`codespar card ${String(base.action)}\`.`);
  }
  const args: Record<string, unknown> = { ...base, action };
  for (const [flag, arg] of FLAG_TO_ARG) {
    if (opts[flag] !== undefined) args[arg] = opts[flag];
  }
  if (opts.holder !== undefined) {
    try {
      const holder = JSON.parse(opts.holder) as unknown;
      if (typeof holder !== "object" || holder === null || Array.isArray(holder)) throw new Error("not an object");
      args.holder = holder;
    } catch (err) {
      throw new CliError(`card ${action}: --holder must be a JSON object (${(err as Error).message}).`);
    }
  }
  if (cardId !== undefined) args.card_id = cardId;
  if (typeof args.currency === "string") args.currency = args.currency.toUpperCase();
  const card = args as unknown as CardArgs;
  validateCardArgs(card);
  return card;
}

function oneOf(field: string, value: unknown, published: readonly string[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !published.includes(value)) {
    throw new CliError(`card.${field} must be one of: ${published.join(", ")}.`);
  }
}

/** Refuse locally what the server would refuse anyway. Vocabularies come from the published definition. */
export function validateCardArgs(args: CardArgs): void {
  const actions = metaToolActions(TOOL);
  if (!args.action || !actions.includes(args.action)) {
    throw new CliError(`card.action must be one of: ${actions.join(", ")}.`);
  }
  const a = args as unknown as Record<string, unknown>;
  oneOf("currency", a.currency, metaToolEnum(TOOL, "currency"));
  oneOf("provider", a.provider, metaToolEnum(TOOL, "provider"));
  oneOf("issuer", a.issuer, metaToolEnum(TOOL, "issuer"));
  oneOf("reason", a.reason, metaToolEnum(TOOL, "reason"));
  if (args.action === "issue") {
    if (!args.currency) throw new CliError("card issue needs --currency (BRL | USD).");
    if (!args.mandate_id) throw new CliError("card issue needs --mandate-id.");
    if (!args.consumer_id) throw new CliError("card issue needs --consumer-id.");
    if (!args.idempotency_key) {
      throw new CliError(
        "card issue needs --idempotency-key. Keep the key: running the same command again with it resumes the same request and never issues a second card.",
      );
    }
  }
  if (args.action !== "issue" && args.action !== "list" && !args.card_id) {
    throw new CliError(`card ${args.action} needs a card id (icrd_... or rcrd_...).`);
  }
}

function retryAfter(seconds: number | undefined): string {
  return typeof seconds === "number" ? ` in ${seconds}s` : "";
}

function viewPairs(v: CardView): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ["Id", v.id],
    ["Issuer", v.issuer],
    ["Program", v.program],
    ["Currency", v.currency],
    ["Status", v.issuer_status ? `${v.status} (${v.issuer_status})` : v.status],
    ["Actions", v.available_actions.length > 0 ? v.available_actions.join(", ") : "none"],
  ];
  if (v.last4) pairs.push(["Last four", v.last4]);
  if (v.mandate_id) pairs.push(["Mandate", v.mandate_id]);
  if (v.consumer_id) pairs.push(["Consumer", v.consumer_id]);
  return pairs;
}

/**
 * Print a result, or throw for a refusal (a definitive issuer failure is one). The
 * non-final issue states (`pending_human`, `processing`, `uncertain`) are
 * not failures (REST answers 202): they print what happens next and exit 0,
 * and a script branches on `state` in `--json`. None of them ever suggests a
 * new key: processing and uncertain resolve on the same one.
 */
export function renderCardResult(action: string, result: CardResult, asJson: boolean, args?: CardArgs): void {
  if (result.state === "refused") {
    // A definitive issuer refusal is a refusal too (card_issue_refused, or
    // card_issue_request_failed with failure_code on a later call with the
    // same key): a failure for the exit code.
    const failure = result.failure_code ? ` [failure_code ${result.failure_code}]` : "";
    // The issuer may or may not have applied the change: read before acting again.
    const hint = result.code === "card_control_uncertain" && args && "card_id" in args ? ` Read it again: codespar card get ${args.card_id}.` : "";
    throw new HttpError(
      `card ${action} refused: ${result.code}${result.reason ? ` (${result.reason})` : ""}${failure}${result.message ? ` — ${result.message}` : ""}${hint}`,
      { status: result.http_status, code: result.code, body: result },
    );
  }
  if (asJson) {
    json(result);
    return;
  }
  if (result.state === "pending_human") {
    warn(`card issue waiting on a person at ${result.issuer}/${result.program}: ${result.pending_action.kind}, for the ${result.pending_action.actor}`);
    if (result.pending_action.url) info(`Hand this to them: ${result.pending_action.url}`);
    info(`Request: ${result.issue_request_id}. Once it is done, run the same command with the same --idempotency-key.`);
    return;
  }
  if (result.state === "processing") {
    warn(`card issue processing at ${result.issuer}/${result.program}: the issuer has not answered yet.`);
    info(
      `Request: ${result.issue_request_id}. Run the same command with the same --idempotency-key${retryAfter(result.retry_after_seconds)} to read where it stands; never a new key.`,
    );
    return;
  }
  if (result.state === "uncertain") {
    warn(
      `card issue uncertain at ${result.issuer}/${result.program}: the issuer's answer was lost or ambiguous, and the card MAY exist${result.issuer_code ? ` (issuer code ${result.issuer_code})` : ""}.`,
    );
    if (result.note) info(result.note);
    info(
      `Request: ${result.issue_request_id}. It reconciles on the same key: run the same command with the SAME --idempotency-key${retryAfter(result.retry_after_seconds)}. Do not use a new key; that would be a second issuance.`,
    );
    return;
  }
  if ("cards" in result) {
    table(
      ["ID", "ISSUER", "PROGRAM", "CURRENCY", "STATUS", "ACTIONS"],
      result.cards.map((v) => [v.id, v.issuer, v.program, v.currency, v.status, v.available_actions.join(",") || "-"]),
    );
    return;
  }
  if (result.state === "issued") {
    success(`card issue → ${result.card.status} (request ${result.issue_request_id})`);
    kv(viewPairs(result.card));
    // `selection` is read defensively: the contract always sends it, but a
    // missing one must not crash the print of a card that was in fact issued.
    const selection = result.selection as CardIssued["selection"] | undefined;
    if (selection) {
      info(`Selection: ${selection.chosen_by === "provider" ? `provider ${selection.provider_requested ?? ""}` : "by currency"}`);
    }
    return;
  }
  success(`card ${action} → ${result.status}`);
  kv(viewPairs(result));
}

/**
 * Wraps `session.card(args)` — issue, read, list, freeze, unfreeze or cancel
 * a card on whichever issuer the server resolves (BRL -> pomelo_brl, USD ->
 * rain_usd). The meta-tool router resolves the rail, so no `--server`.
 */
export async function cardCommand(action: string, cardId: string | undefined, opts: CardCommandOptions): Promise<void> {
  const args = await buildCardArgs(action, cardId, opts);

  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, projectId: opts.project });
  const session = await cs.create(opts.user ?? "cli-user", { servers: [] });
  try {
    const result = await session.card(args);
    renderCardResult(action, result, opts.json === true, args);
  } finally {
    await session.close();
  }
}

/** `codespar card readiness`: `GET /v1/cards/readiness`, per program what is missing and who must act. */
export async function cardReadinessCommand(opts: { apiKey: string; baseUrl: string; project?: string; json?: boolean }): Promise<void> {
  const cs = new CodeSpar({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, projectId: opts.project });
  const readiness = await cs.cards.readiness();
  if (opts.json) {
    json(readiness);
    return;
  }
  for (const p of readiness.programs) {
    (p.ready ? success : warn)(`${p.program} (${p.issuer}, ${p.currency}): ${p.ready ? "ready" : "not ready"}`);
    table(
      ["REQUIREMENT", "STATUS", "ACTOR", "DETAIL"],
      p.requirements.map((r) => [r.kind, r.status, r.actor, r.action_url ?? r.reason ?? "-"]),
    );
  }
}
