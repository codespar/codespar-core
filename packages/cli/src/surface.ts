/**
 * The CLI's command surface, derived from the published API surface.
 *
 * Two sources, both published, neither retyped here:
 *
 *   `API_OPERATIONS` (@codespar/sdk)               — every REST operation of
 *                                                    the served OpenAPI document
 *   `SHARED_META_TOOL_DEFINITIONS` (@codespar/types,
 *    re-exported by @codespar/sdk)                 — the 15 agent-facing meta-tools
 *
 * A resource command group is a path prefix plus a name; the subcommands
 * under it are computed from the operation rows that live under that
 * prefix. There is no per-route code: adding a group is one row in
 * `PUBLISHED_GROUPS`, and a route added to the served document appears as
 * a subcommand the next time the SDK snapshot is refreshed.
 *
 * `auditSurface()` is the checker behind the coverage gate
 * (`__tests__/surface-coverage.test.ts`): it takes the surface as an
 * argument instead of reading the module's own constants, so the gate can
 * run it against synthetic inputs and prove it fails when it should.
 */

import { API_OPERATIONS, SHARED_META_TOOL_DEFINITIONS } from "@codespar/sdk";
import type { SharedMetaToolDefinition } from "@codespar/sdk";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface OperationRow {
  method: HttpMethod;
  path: string;
  /** Request body content type, or null when the operation takes no body. */
  body: string | null;
}

/** Every operation of the served document, as plain rows. */
export const OPERATIONS: readonly OperationRow[] = API_OPERATIONS.map((row) => ({
  method: row.method as HttpMethod,
  path: row.path as string,
  body: row.body as string | null,
}));

/* ── Census ───────────────────────────────────────────────────────── */

/**
 * The resource group an operation belongs to, for census purposes: the
 * first path segment after the version prefix (`/v1/wallets/{id}/ledger`
 * → `wallets`), or `(non-v1) <segment>` for the handful of unversioned
 * routes. Coarse on purpose — the census asks "does this family of
 * routes have any CLI at all", not "is every route wired".
 */
export function censusGroup(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments[0] !== "v1") return `(non-v1) ${segments[0] ?? ""}`;
  return segments[1] ?? "";
}

/** Every census group of the served document, with its operations. */
export function census(
  operations: readonly OperationRow[] = OPERATIONS,
): Map<string, OperationRow[]> {
  const groups = new Map<string, OperationRow[]>();
  for (const op of operations) {
    const key = censusGroup(op.path);
    const bucket = groups.get(key);
    if (bucket) bucket.push(op);
    else groups.set(key, [op]);
  }
  return groups;
}

/* ── Published resource groups ────────────────────────────────────── */

export interface GroupSpec {
  /** Command name: `codespar <name> <subcommand>`. */
  name: string;
  /** Path prefix that claims an operation. Params are written `{}`. */
  prefix: string;
  /** One-line description for `codespar --help`. */
  description: string;
}

/**
 * The resource groups this CLI publishes. Each row is a prefix; an
 * operation belongs to the LONGEST prefix that matches it, so
 * `/v1/consumers/{}/dda/...` lands in `boletos` and every other
 * `/v1/consumers/...` route lands in `consumers`.
 *
 * Onda 4 of the API matrix (v2.1.1) names admin, sellers, mcp-servers,
 * consumers and boletos; core#125 adds the money methods (wallets,
 * triggers, and the meta-tools below). `admin` is absent on purpose: the
 * served document declares no `/v1/admin/*` operation, so there is
 * nothing to derive a command from (see SURFACE_EXCEPTIONS).
 */
export const PUBLISHED_GROUPS: readonly GroupSpec[] = [
  {
    name: "consumers",
    prefix: "/v1/consumers",
    description: "Consumers: profile, Pix keys, Pix lookups, receipts, contact verification",
  },
  {
    name: "boletos",
    prefix: "/v1/consumers/{}/dda",
    description: "DDA boletos: subscribe a document, list the boletos it receives",
  },
  {
    name: "sellers",
    prefix: "/v1/sellers",
    description: "Sellers: onboarding status, custody, pending settlement, ledger",
  },
  {
    name: "mcp-servers",
    prefix: "/v1/mcp-servers",
    description: "Tenant MCP servers: register, validate, list, patch a tool, sweep platform fees",
  },
  {
    name: "wallets",
    prefix: "/v1/wallets",
    description: "Wallets: balances, ledger, funding sources, execute, transfer, custody",
  },
  {
    name: "triggers",
    prefix: "/v1/triggers",
    description: "Triggers (webhooks): endpoints, deliveries, DLQ, secret rotation, redelivery",
  },
  // Both families below arrived in the served document when packages/core
  // refreshed openapi-snapshot.json to 221 operations (core#143). They are
  // published, not excepted: the coverage gate reserves an exception for a
  // family with no terminal use, and both of these end at a person.
  {
    name: "consents",
    prefix: "/v1/consents",
    description: "Consent tokens: mint the token whose URL the consumer opens to authorise an agent",
  },
  {
    name: "consumer-payments",
    prefix: "/v1/consumer-payments",
    description:
      "Consumer payments: execute a payment on a consumer's behalf, with the audit chain (execute-stream returns SSE)",
  },
];

/* ── Derivation ───────────────────────────────────────────────────── */

export interface DerivedCommand {
  /** Subcommand name: `codespar <group> <name>`. */
  name: string;
  method: HttpMethod;
  /** Path template, `{param}` unexpanded. */
  path: string;
  /** Path parameter names, in path order — the command's positional arguments. */
  params: string[];
  /** True when the operation declares a request body. */
  acceptsBody: boolean;
}

export interface DerivedGroup {
  spec: GroupSpec;
  commands: DerivedCommand[];
}

/** `{anything}` → `{}`, so a prefix matches whatever the params are called. */
function normalise(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** Segment-wise prefix test: `/v1/consumers/{}/dda` matches `/v1/consumers/{cid}/dda/boletos`. */
function underPrefix(path: string, prefix: string): boolean {
  const p = normalise(path).split("/");
  const q = prefix.split("/");
  if (p.length < q.length) return false;
  return q.every((segment, i) => segment === p[i]);
}

/** The group spec that claims an operation: the longest matching prefix. */
export function claimingGroup(
  path: string,
  groups: readonly GroupSpec[] = PUBLISHED_GROUPS,
): GroupSpec | undefined {
  let best: GroupSpec | undefined;
  for (const spec of groups) {
    if (!underPrefix(path, spec.prefix)) continue;
    if (!best || spec.prefix.length > best.prefix.length) best = spec;
  }
  return best;
}

const COLLECTION_VERB: Record<HttpMethod, string> = {
  get: "list",
  post: "create",
  put: "set",
  patch: "update",
  delete: "delete",
};

/**
 * Derive the subcommands of one group.
 *
 * The name of a subcommand is a pure function of the operation set, not
 * of the order rows appear in: the literal segments below the group's
 * prefix form a suffix, and the suffix is used bare when it identifies
 * exactly one operation in the group, or prefixed with the method's verb
 * when two or more operations share it (`triggers list-deliveries` vs
 * `triggers get-deliveries`). A route with no literal suffix is named
 * after its verb alone (`list`, `get`, `create`, `update`, `delete`), and
 * a suffix that merely repeats the group name collapses to the verb too
 * (`GET /v1/consumers/{}/dda/boletos` is `boletos list`, not
 * `boletos boletos`).
 *
 * The names are pinned in `__tests__/resource-commands.test.ts`, so a
 * spec change that renames an existing command is a red test, not a
 * silent break in someone's script.
 */
export function deriveGroup(
  spec: GroupSpec,
  operations: readonly OperationRow[] = OPERATIONS,
  groups: readonly GroupSpec[] = PUBLISHED_GROUPS,
): DerivedGroup {
  const rows = operations.filter((op) => claimingGroup(op.path, groups)?.name === spec.name);
  const depth = spec.prefix.split("/").length;

  const parsed = rows.map((op) => {
    const all = op.path.split("/").filter(Boolean);
    const segments = op.path.split("/").slice(depth);
    const literals = segments.filter((s) => !isParam(s));
    // Positionals come from the WHOLE path, not just the part below the
    // prefix: `boletos` hangs off `/v1/consumers/{consumerId}/dda`, and
    // dropping the parameter the prefix passes over would build a command
    // that cannot address a consumer at all.
    const params = all.filter(isParam).map((s) => s.slice(1, -1));
    const endsWithParam = segments.length > 0 && isParam(segments[segments.length - 1]!);
    const suffix = literals.join("-");
    const verb = op.method === "get" ? (endsWithParam ? "get" : "list") : COLLECTION_VERB[op.method];
    return { op, suffix, verb, params };
  });

  const suffixCount = new Map<string, number>();
  for (const p of parsed) suffixCount.set(p.suffix, (suffixCount.get(p.suffix) ?? 0) + 1);

  const commands = parsed.map(({ op, suffix, verb, params }) => {
    const bare = suffix === "" || suffix === spec.name;
    const name = bare ? verb : suffixCount.get(suffix) === 1 ? suffix : `${verb}-${suffix}`;
    return {
      name,
      method: op.method,
      path: op.path,
      params,
      acceptsBody: op.body !== null,
    };
  });

  return { spec, commands };
}

/** Every published group, derived. */
export function derivedSurface(
  groups: readonly GroupSpec[] = PUBLISHED_GROUPS,
  operations: readonly OperationRow[] = OPERATIONS,
): DerivedGroup[] {
  return groups.map((spec) => deriveGroup(spec, operations, groups));
}

/* ── Meta-tools ───────────────────────────────────────────────────── */

/**
 * The 15 agent-facing meta-tools, read from the published definitions.
 * Never a list written here: `@codespar/types` publishes the names, the
 * input schemas and the closed vocabularies (ent#933), and the CLI shows
 * exactly those.
 */
export const META_TOOLS: Readonly<Record<string, SharedMetaToolDefinition>> =
  SHARED_META_TOOL_DEFINITIONS;

export function metaToolNames(): string[] {
  return Object.keys(META_TOOLS);
}

export function metaToolDefinition(name: string): SharedMetaToolDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(META_TOOLS, name) ? META_TOOLS[name] : undefined;
}

/**
 * The closed vocabulary of a meta-tool's `action` property, or an empty
 * array when the tool has no `action` (codespar_kyc discriminates on
 * `check_type`, codespar_discover on `use_case`).
 */
export function metaToolActions(name: string): readonly string[] {
  return metaToolDefinition(name)?.contract.enums?.action ?? [];
}

/* ── Coverage gate ────────────────────────────────────────────────── */

export interface SurfaceException {
  /** Why this group has no derived command group. Must say something. */
  reason: string;
  /** ISO date the exception was written, so an old one is visible as old. */
  since: string;
}

/**
 * Census groups with no derived command group, each with a reason and a
 * date. This list is a ratchet: it may shrink, never grow. Adding an
 * entry to get the gate green is the wrong move — the machinery makes a
 * group one row in `PUBLISHED_GROUPS`.
 *
 * Only census groups belong here. The admin/account family the API
 * matrix names has no entry because it has no served route to except:
 * `surface-coverage.test.ts` asserts the document still declares no
 * `/v1/admin/*` operation, and goes red the day it does.
 */
export const SURFACE_EXCEPTIONS: Readonly<Record<string, SurfaceException>> = {
  "(non-v1) .well-known": {
    reason:
      "OAuth protected-resource and authorization-server discovery documents. Read by MCP clients during handshake, never by a person at a terminal.",
    since: "2026-09-10",
  },
  "(non-v1) oauth": {
    reason:
      "OAuth register/authorize/token. A browser redirect flow; `codespar login` and `codespar connect start` are the terminal-side entrances.",
    since: "2026-09-10",
  },
  "(non-v1) openapi.json": {
    reason:
      "The served spec document itself. `npm run spec:refresh` in packages/core is the maintained way to pull it, and it regenerates the client at the same time.",
    since: "2026-09-10",
  },
  "openapi.json": {
    reason:
      "Versioned alias of the served spec document. Same reason as the unversioned one: spec:refresh, not a CLI command.",
    since: "2026-09-10",
  },
  servers: {
    reason: "Covered by the pre-existing `codespar servers list|show` commands (hand-written paths).",
    since: "2026-09-10",
  },
  sessions: {
    reason:
      "Covered by the pre-existing `codespar sessions list|show|close` and `codespar execute` commands (hand-written paths).",
    since: "2026-09-10",
  },
  connections: {
    reason: "Covered by the pre-existing `codespar connect list|start|revoke` commands.",
    since: "2026-09-10",
  },
  connect: {
    reason: "POST /v1/connect/start is what `codespar connect start` calls.",
    since: "2026-09-10",
  },
  whoami: {
    reason: "Covered by the pre-existing `codespar whoami` command.",
    since: "2026-09-10",
  },
  "tool-calls": {
    reason:
      "Covered by the pre-existing `codespar payment-status` and `codespar verification-status` commands, including their SSE streams.",
    since: "2026-09-10",
  },
  "meta-tools": {
    reason: "POST /v1/meta-tools/discover is what `codespar discover` calls.",
    since: "2026-09-10",
  },
  "webhook-endpoints": {
    reason:
      "The same ten operations as `triggers`, under the older path family. The CLI publishes the canonical `triggers` name only; wiring both would double the surface for one backend.",
    since: "2026-09-10",
  },
  mandates: {
    reason:
      "Org-scoped mandate lifecycle (pause/resume/revoke). `codespar mandate create|verify` covers issuance and offline verification; the lifecycle verbs are wave-5 work in the matrix.",
    since: "2026-09-10",
  },
  orgs: {
    reason: "Org administration (agents, keys, audit config, approvals, data-subject anonymisation). Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  organizations: {
    reason: "Single org read. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  projects: {
    reason: "Project CRUD and settings history. Dashboard surface; not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  policies: {
    reason: "Policy CRUD and reorder. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "policy-evaluations": {
    reason: "Policy evaluation log. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  evaluations: {
    reason: "Evaluation log alias. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "audit-events": {
    reason: "Audit event stream, incidents and config. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  audit: {
    reason: "Audit event alias. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  approvals: {
    reason: "Approval reads used by the caller-side poll in approval-status.ts, not by an operator at a terminal.",
    since: "2026-09-10",
  },
  "commerce-memory": {
    reason: "Counterparties, interactions, preferences, negotiations and insights. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  counterparties: {
    reason: "Counterparty reads outside commerce-memory. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "payment-links": {
    reason: "Payment link CRUD. Dashboard surface; not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  paywalls: {
    reason: "Paywall reads and stats. Dashboard surface; not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  providers: {
    reason: "Provider catalog and auth schemas. `codespar servers` and `codespar wizard` are the terminal entrances.",
    since: "2026-09-10",
  },
  agents: {
    reason: "Agent registration and key rotation. Security-sensitive; wants its own design pass, not a derived command.",
    since: "2026-09-10",
  },
  ofb: {
    reason: "Open Finance Brasil consent lifecycle. Browser redirect flow; not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "bank-consents": {
    reason: "Single bank-consent read, alias of the ofb family. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "consent-records": {
    reason: "Single consent-record read. Not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  "account-applications": {
    reason: "Single account-application read. Belongs with the admin/account family that has no served routes yet.",
    since: "2026-09-10",
  },
  kyc: {
    reason: "GET /v1/kyc/onboard/{proposalId}/status. Reachable as `codespar tool codespar_kyc --action status`.",
    since: "2026-09-10",
  },
  cards: {
    reason: "Single card read. Reachable as `codespar tool codespar_issue --action card-get`.",
    since: "2026-09-10",
  },
  issuer: {
    reason: "Issuer-side card read, alias of the cards family. Same meta-tool covers it.",
    since: "2026-09-10",
  },
  "funding-sources": {
    reason: "Single funding-source read. The wallet-scoped ones are wired under `codespar wallets`.",
    since: "2026-09-10",
  },
  facilitator: {
    reason: "x402 facilitator executions. Machine-to-machine surface driven by the x402 rail, not by an operator.",
    since: "2026-09-10",
  },
  cart: {
    reason: "Mercado Livre / iFood cart connect starts. Browser redirect flow; `codespar connect start` is the terminal entrance.",
    since: "2026-09-10",
  },
  fees: {
    reason: "Fee schedule reads. Pricing surface; not in onda 4 of the matrix.",
    since: "2026-09-10",
  },
  events: {
    reason: "Event replay. Operational recovery tool; wants an explicit confirmation design, not a derived command.",
    since: "2026-09-10",
  },
  generate: {
    reason: "Server-generation helper used by the dashboard scaffolder. `codespar init` is the terminal scaffolder.",
    since: "2026-09-10",
  },
  discovery: {
    reason: "Discovery manifest, read by agent clients during handshake.",
    since: "2026-09-10",
  },
  health: {
    reason: "Liveness probe. `curl` is the right tool and needs no API key.",
    since: "2026-09-10",
  },
};

/** How many exceptions the gate expects. Lower it when one goes away. */
export const EXCEPTION_PIN = 43;

export type ViolationKind =
  | "uncovered-group"
  | "empty-reason"
  | "bad-date"
  | "stale-exception"
  | "meta-tool-missing";

export interface Violation {
  kind: ViolationKind;
  subject: string;
  detail: string;
}

export interface SurfaceAudit {
  /** Census group names present in the surface under audit. */
  censusGroups: readonly string[];
  /** Census group names that a derived command group covers. */
  coveredGroups: readonly string[];
  exceptions: Readonly<Record<string, SurfaceException>>;
  /** Meta-tool names the surface publishes. */
  publishedMetaTools: readonly string[];
  /** Meta-tool names the CLI can invoke. */
  invocableMetaTools: readonly string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON = 20;

/**
 * The check itself, as a pure function of the surface handed to it. The
 * gate runs it twice on synthetic inputs — once on a surface that is
 * covered, once on a surface that is not — so a checker that cannot fail
 * is caught by its own controls.
 */
export function auditSurface(input: SurfaceAudit): Violation[] {
  const violations: Violation[] = [];
  const covered = new Set(input.coveredGroups);
  const census = new Set(input.censusGroups);

  for (const group of input.censusGroups) {
    if (covered.has(group)) continue;
    const exception = input.exceptions[group];
    if (!exception) {
      violations.push({
        kind: "uncovered-group",
        subject: group,
        detail: `resource group "${group}" has no command and no written exception`,
      });
      continue;
    }
    if (!exception.reason || exception.reason.trim().length < MIN_REASON) {
      violations.push({
        kind: "empty-reason",
        subject: group,
        detail: `exception for "${group}" has no usable reason (needs at least ${MIN_REASON} characters saying why)`,
      });
    }
    if (!ISO_DATE.test(exception.since ?? "")) {
      violations.push({
        kind: "bad-date",
        subject: group,
        detail: `exception for "${group}" has no ISO date (YYYY-MM-DD) saying when it was written`,
      });
    }
  }

  for (const group of Object.keys(input.exceptions)) {
    if (census.has(group) && !covered.has(group)) continue;
    violations.push({
      kind: "stale-exception",
      subject: group,
      detail: covered.has(group)
        ? `"${group}" has a command AND an exception — delete the exception`
        : `"${group}" is not a resource group of the served document — delete the exception`,
    });
  }

  const invocable = new Set(input.invocableMetaTools);
  for (const name of input.publishedMetaTools) {
    if (invocable.has(name)) continue;
    violations.push({
      kind: "meta-tool-missing",
      subject: name,
      detail: `meta-tool "${name}" is published but the CLI cannot invoke it`,
    });
  }

  return violations;
}
