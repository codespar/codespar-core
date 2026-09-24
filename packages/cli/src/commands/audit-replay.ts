import { ApiClient, HttpError } from "../api.js";
import { CliError } from "../config.js";
import { c, info, json, kv, success, warn } from "../output.js";
import { VERSION } from "../version.js";

/**
 * `codespar audit replay` — the verdict on an audit-chain interval, asked of
 * the API and rendered here.
 *
 * ## Why this composes two reads instead of calling one verifier
 *
 * There is no endpoint that verifies a chain for an INTERVAL. The backend's
 * verification lives in two places and neither is an interval verdict over
 * HTTP: `audit-verification-job` is a cron that walks each org's chain and
 * persists a watermark, and `@codespar-enterprise/audit-verify` is a private,
 * offline verifier over an export FILE with its own binary, never published.
 * The caller-facing face of the cron's work is `GET /v1/audit-events/health`,
 * which reports the whole chain: `actionable_status`, the watermark the walk
 * reached, and a live re-check of the five newest rows.
 *
 * So the interval verdict is assembled from two typed reads:
 *
 *   `GET /v1/audit-events/health`  — what the verifier says about the chain
 *   `GET /v1/audit-events`         — which sequences the interval covers
 *
 * and the only arithmetic here is the comparison the health payload defines
 * for itself: `watermark_sequence` is documented as "everything at or below
 * this has been walked and verified", so an interval whose highest sequence is
 * at or below it has been verified, and one above it has not. No hash is
 * recomputed and no chain link is checked in this process. That is deliberate:
 * a second implementation of the chain check is the one thing the proof bundle
 * spec forbids, because two implementations that disagree prove nothing.
 *
 * ## What a verdict does NOT claim
 *
 * `link_unverifiable` and `degraded` are read off the chain's global status,
 * not intersected with the interval. An unverifiable segment or an open
 * incident elsewhere in the chain therefore colours this interval too. That is
 * the fail-closed direction, and the segment's own `from`/`to` travel in the
 * payload so a reader can see whether it overlaps.
 */

/** Events read per page. The API clamps to 1..200. */
const PAGE_SIZE = 200;

/**
 * Pages walked before the listing is declared truncated.
 *
 * A bound is needed because the window is the caller's and an org's chain is
 * unbounded. It costs nothing on the verdict: the verdict turns on the HIGHEST
 * sequence in the interval, which arrives on the first page (the listing is
 * newest-first). Truncation only loses the floor and the exact count, and the
 * payload says so rather than reporting a short count as if it were whole.
 */
const MAX_PAGES = 50;

export type AuditReplayVerdict =
  | "verified"
  | "unverified"
  | "link_unverifiable"
  | "degraded"
  | "broken"
  | "no_events";

export interface AuditReplayOptions {
  /** ISO 8601. Omitted leaves the window to the API's own default. */
  from?: string;
  to?: string;
  json?: boolean;
}

export interface IntervalEvents {
  count: number;
  firstSequence: number | null;
  lastSequence: number | null;
  truncated: boolean;
}

/** ISO 8601 in, ISO 8601 out. A date-only value is UTC midnight, as `Date` reads it. */
function normaliseInstant(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new CliError(
      `${flag} is not a date this CLI can read: ${JSON.stringify(value)}. ` +
        `Use ISO 8601, e.g. 2026-09-24T14:30:00Z.`,
      { code: "invalid_iso_8601" },
    );
  }
  return new Date(ms).toISOString();
}

/**
 * A 404 on this pair means the deployment predates the audit-chain resource,
 * not that the caller asked for something wrong. Saying so is the difference
 * between an actionable refusal and a stack trace over a missing route.
 */
function missingEndpoint(err: unknown, path: string): unknown {
  if (err instanceof HttpError && err.status === 404) {
    return new CliError(
      `This deployment does not serve ${path}, so there is no chain verdict to read. ` +
        `\`codespar audit replay\` needs a CodeSpar API that exposes the audit-chain ` +
        `resource; check --base-url, or ask your operator which version is deployed.`,
      { code: "audit_chain_unsupported" },
    );
  }
  return err;
}

async function readHealth(client: ApiClient) {
  try {
    return await client.get("/v1/audit-events/health");
  } catch (err) {
    throw missingEndpoint(err, "GET /v1/audit-events/health");
  }
}

/**
 * Walk the interval newest-first and report its span. The cursor contract is
 * the API's: a full page returns a non-null `next_before_sequence`, so the
 * last call is the one that returns fewer rows than `limit`.
 */
async function readInterval(
  client: ApiClient,
  from: string | undefined,
  to: string | undefined,
): Promise<IntervalEvents> {
  let count = 0;
  let firstSequence: number | null = null;
  let lastSequence: number | null = null;
  let before: number | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await client
      .get("/v1/audit-events", {
        query: {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          limit: PAGE_SIZE,
          ...(before === undefined ? {} : { before_sequence: before }),
        },
      })
      .catch((err: unknown) => {
        throw missingEndpoint(err, "GET /v1/audit-events");
      });

    const events = answer.events;
    for (const event of events) {
      count++;
      if (lastSequence === null || event.sequence_number > lastSequence) {
        lastSequence = event.sequence_number;
      }
      if (firstSequence === null || event.sequence_number < firstSequence) {
        firstSequence = event.sequence_number;
      }
    }

    if (events.length < PAGE_SIZE || answer.next_before_sequence === null) {
      return { count, firstSequence, lastSequence, truncated: false };
    }
    before = answer.next_before_sequence;
  }

  return { count, firstSequence: null, lastSequence, truncated: true };
}

interface Decision {
  verdict: AuditReplayVerdict;
  reason: string;
}

/**
 * The verdict, as a function of what the API said. Every branch quotes a field
 * of the health payload; nothing here inspects an event or a hash.
 */
export function decide(
  actionableStatus: string,
  watermarkSequence: number,
  events: IntervalEvents,
): Decision {
  if (actionableStatus === "broken") {
    return {
      verdict: "broken",
      reason:
        "The API reports the chain as broken: a row is not what the chain says it is. " +
        "Nothing in this interval can be taken as verified.",
    };
  }
  if (actionableStatus === "degraded") {
    return {
      verdict: "degraded",
      reason:
        "The API reports an open chain-integrity incident. The incident is not " +
        "intersected with this interval, so check the incident's own sequence range.",
    };
  }
  if (actionableStatus === "link_unverifiable") {
    return {
      verdict: "link_unverifiable",
      reason:
        "The API reports a stretch of chain with no verified link — absence of proof, " +
        "not evidence of tampering. The segment's range is in chain.unverifiable_segment.",
    };
  }
  if (events.count === 0) {
    return {
      verdict: "no_events",
      reason: "The interval holds no audit events, so there was nothing to verify.",
    };
  }
  if (events.lastSequence !== null && events.lastSequence <= watermarkSequence) {
    return {
      verdict: "verified",
      reason:
        `The verifier has walked the chain through sequence ${watermarkSequence}, and the ` +
        `interval ends at ${events.lastSequence}, so every event in it has been verified.`,
    };
  }
  return {
    verdict: "unverified",
    reason:
      `The verifier has walked the chain through sequence ${watermarkSequence} and the ` +
      `interval reaches ${events.lastSequence}, so part of it has not been verified yet. ` +
      `This is normal shortly after a run; ask again once the verifier catches up.`,
  };
}

export async function auditReplayCommand(
  client: ApiClient,
  opts: AuditReplayOptions = {},
): Promise<void> {
  const from = normaliseInstant(opts.from, "--from");
  const to = normaliseInstant(opts.to, "--to");
  if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) {
    throw new CliError("--from is after --to; the interval is empty.", { code: "from_after_to" });
  }

  const health = await readHealth(client);
  const events = await readInterval(client, from, to);

  const verification = health.verification;
  const link = verification.chain_link_check;
  const segment = link.oldest_unverifiable_segment;
  const { verdict, reason } = decide(health.actionable_status, verification.watermark_sequence, events);

  const document = {
    verdict,
    reason,
    interval: { from: from ?? null, to: to ?? null },
    events: {
      count: events.count,
      first_sequence: events.firstSequence,
      last_sequence: events.lastSequence,
      truncated: events.truncated,
    },
    chain: {
      actionable_status: health.actionable_status,
      status: health.status,
      detail: health.detail,
      last_sequence_number: health.last_sequence_number,
      last_checked_at: health.last_checked_at,
      watermark_sequence: verification.watermark_sequence,
      watermark_at: verification.watermark_at,
      watermark_entry_hash: verification.watermark_entry_hash,
      writer_tip_check_passed: verification.writer_tip_check_passed,
      writer_tip_check_at: verification.writer_tip_check_at,
      unverifiable_segments: link.unverifiable_segments,
      unverifiable_segment: segment ?? null,
      watermark_pinned_by_break_at: link.watermark_pinned_by_break_at,
      open_incidents: health.incidents.open_count,
    },
    // What produced the verdict, so a bundle carrying this file says where it
    // came from instead of asking a reader to trust the filename.
    verified_by: {
      producer: `codespar-cli/${VERSION}`,
      chain_verdict: "GET /v1/audit-events/health",
      interval_events: "GET /v1/audit-events",
      note: "The chain check runs server-side; this CLI renders the answer and does not recompute any hash.",
    },
  };

  if (events.truncated) {
    warn(
      `More than ${MAX_PAGES * PAGE_SIZE} events in this interval: the count is a floor and ` +
        `first_sequence is unknown. The verdict is unaffected — it turns on the highest sequence.`,
    );
  }

  if (verdict !== "verified") process.exitCode = 1;

  // The one-line verdict goes to stderr in BOTH modes. `--json` owns stdout
  // and nothing else may touch it, but a person watching a piped run still
  // gets the answer, which is the contract the rest of the CLI keeps.
  if (verdict === "verified") success(`audit chain verified over the interval (${events.count} events)`);
  else if (verdict === "no_events") info("no audit events in this interval; nothing was verified");
  else warn(`audit chain NOT verified over the interval: ${verdict}`);

  if (opts.json) {
    json(document);
    return;
  }

  process.stdout.write(c.bold("\ninterval\n"));
  kv([
    ["from", from ?? c.gray("(API default window)")],
    ["to", to ?? c.gray("(API default window)")],
    ["events", events.truncated ? `${events.count}+ (truncated)` : String(events.count)],
    [
      "sequences",
      events.lastSequence === null
        ? "-"
        : `${events.firstSequence ?? "?"} … ${events.lastSequence}`,
    ],
  ]);

  process.stdout.write(c.bold("\nchain\n"));
  kv([
    ["actionable_status", health.actionable_status],
    ["detail", health.detail],
    ["chain_tip", String(health.last_sequence_number)],
    ["verified_through", String(verification.watermark_sequence)],
    ["writer_tip_check", String(verification.writer_tip_check_passed)],
    ["open_incidents", String(health.incidents.open_count)],
    [
      "unverifiable_segment",
      segment === null || segment === undefined
        ? "(none)"
        : `${segment.from_sequence} … ${segment.to_sequence} (${segment.reason})`,
    ],
  ]);

  process.stdout.write("\n");
  info(reason);
}
