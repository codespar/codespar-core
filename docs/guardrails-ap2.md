# Guardrails (Hybrid AP2) — product + design doc

**Status:** P0 strategic differentiation. Not yet scheduled. This doc is the target spec for when we do schedule it.

**Audience:** Daniel (co-dev) + future engineers joining. Readers are expected to know what CodeSpar's Tool Router does. If not, read `tool-router-and-bacr.md` first.

---

## 1. The product question this answers

When an agent is authorized to execute commerce (pay, invoice, ship, notify), we need a layer that says **yes/no/ask-human** per call — and produces auditable proof of **why**.

Without Guardrails, every integration has the same failure mode waiting: the agent decides something is fine, the LLM hallucinates context, a real R$10.000 Pix goes out, and the post-mortem can't even reconstruct what the agent "thought" because we only logged the tool call, not the decision.

**Guardrails closes that gap.** It's the policy layer between the LLM and the Tool Router. Every `proxy_execute` / `execute` passes through it. Every decision is recorded. Every denial has a reason the user can read.

---

## 2. Why "hybrid AP2"

**AP2 = Agent Payment Protocol 2**. It's an open spec (Google + ecosystem) for how agents prove they're authorized to execute payments. Core primitive: the **mandate** — a cryptographically signed document from the user authorizing the agent to do X up to amount Y until time Z.

**"Hybrid" because we take AP2's mandate primitive and combine it with a proprietary policy engine:**

- **AP2 part (portable, interoperable):** mandate schema, HMAC signatures, verification semantics. Agents built on other platforms can submit AP2-compatible mandates and we verify them the same way.
- **Proprietary part (moat):** policy evaluation logic — budgets, rate limits, time windows, approval workflows, risk scores, provider-specific rules, learned behavior from our execution dataset. This is where CodeSpar is different.

The split matters strategically. Open-core gets us ecosystem compatibility (agents from n8n, Cursor, etc. can submit mandates). Proprietary core keeps the intelligence compounding on our side.

---

## 3. Existing building blocks (already in repo)

Neither is wired into the API yet. Both need migration to DB and integration into the request path.

### 3.1 `packages/policy-engine` — rule evaluation

**What it does today:**
- Rule types: `allow`, `deny`, `budget`, `rate-limit`, `time-window`, `approval-required`
- Matching on `agents` (ID or `*`) and `tools` (exact, wildcard `*prefix*`, regex-like)
- Priority sort (higher number evaluated first)
- `evaluate(agentId, toolName, estimatedCost?)` returns `{allowed, reason, matchedRule?, budgetRemaining?}`
- `recordUsage(agentId, toolName, cost)` updates budget and rate counters
- In-memory state (rules, budgets, rate counts)

**What's missing:**
- Not called anywhere in the API. The engine is a library, not integrated.
- No context beyond `(agentId, toolName, cost)` — needs provider, session metadata, user tier, recipient, country, risk score
- In-memory — rules + budgets vanish on restart
- No audit log of evaluations (only usage records are kept)
- No support for `when` conditions (time-of-day, day-of-week, session metadata match)

### 3.2 `packages/mandate` — AP2 primitive

**What it does today:**
- `MandateGenerator` creates `Mandate` objects with HMAC-SHA256 signatures
- Signature covers: `id + agentId + amount + currency + expiresAt`
- Types: `payment`, `subscription`, `delegation`
- Supports `maxAmount` (for delegation), `conditions` (stored but not evaluated), `expiresAt`, `authorizedBy`
- `create / verify / revoke / list` in memory

**What's missing:**
- In-memory storage only
- `conditions` array is stored but not verified on use
- No linkage between a mandate and actual tool calls (i.e., "this payment consumed 100 BRL of mandate xyz")
- Not integrated with `proxy_execute` / `execute`

---

## 4. Target architecture

```
                  Agent (OpenAI, Claude, etc.)
                           │
                           ▼
               session.execute / proxyExecute
                           │
                           ▼
              POST /v1/sessions/:id/{execute|proxy_execute}
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
    Bearer auth      loadSession         checkQuota (billing)
                           │
                           ▼
                  ╔════════════════════╗
                  ║   GUARDRAIL GATE   ║   ← new layer
                  ║                    ║
                  ║  1. Load context   ║
                  ║  2. Mandate check  ║
                  ║  3. Policy eval    ║
                  ║  4. Risk score     ║
                  ║  5. Decision log   ║
                  ╚════════════════════╝
                           │
           ┌───────────────┼────────────────┐
           ▼               ▼                ▼
        allow          deny              pending_approval
           │               │                │
           ▼               ▼                ▼
      Tool Router     return 403       return 202 + poll URL
                      with reason      (approval workflow)
                           │
                           ▼
                  INSERT policy_evaluations   ← audit table
```

**Key design decisions:**

- **Guardrails runs AFTER auth + quota, BEFORE resolver + executor.** This matters for cost: a denied call doesn't count against quota (it never hit the upstream), but still gets logged in `policy_evaluations`.
- **Single evaluation point.** Both `/execute` (meta-tools) and `/proxy_execute` (raw HTTP) pass through the same gate. That's the whole point — Guardrails is THE central authority.
- **Decision is a typed object, not a boolean.** `allow | deny | pending_approval` with reason + matched rule + risk score + mandate ref.
- **Pending approvals are first-class.** The agent gets 202 + a poll URL; a human (dashboard or Slack webhook) approves/denies; the queued call executes or is rejected.

---

## 5. Context object — what Guardrails sees

Every evaluation receives a `PolicyContext` assembled from the request + session + DB:

```ts
interface PolicyContext {
  // Identity
  orgId: string;
  userId: string;
  sessionId: string;
  agentId?: string;              // if the agent self-identifies via metadata

  // Action
  kind: "execute" | "proxy_execute";
  toolName: string;              // meta-tool name OR "proxy_execute"
  server: string;                // server_id the call is going to
  endpoint?: string;             // only set for proxy_execute
  method?: string;               // only set for proxy_execute

  // Payload (carefully curated — never the whole body)
  amount?: number;               // extracted from body for payment-like calls
  currency?: string;
  recipient?: string;            // doc, account number, wallet addr
  country?: string;

  // Derived
  estimatedCostUsd?: number;     // dollar estimate for budget checks
  riskScore?: number;            // 0-100 from risk model (MVP: static per server)
  providerReputation?: number;   // 0-100 from execution dataset (MVP: static)

  // Mandate
  mandateId?: string;            // client-supplied, we verify
  mandateRemainingAmount?: number;  // after this call consumes

  // Session metadata
  sessionMetadata?: Record<string, string>;
  clientIp?: string;
  userAgent?: string;
  timestamp: Date;
}
```

The extraction of `amount/currency/recipient/country` from the call body is **per meta-tool** (we know `codespar_pay` has `amount` + `method` + `customer.doc`) and **per proxy endpoint** (we maintain shape maps: Stripe `/v1/charges` → body.amount, Asaas `/v3/payments` → body.value).

Endpoint shape maps are a **new artifact** we need to maintain alongside the provider catalog. Not a blocker for MVP (can do just meta-tools first), but required before proxy_execute goes through Guardrails for real.

---

## 6. Rule types (scope cut for MVP vs later)

### MVP (what's in `policy-engine` today, mostly)

- **allow / deny** — hard yes/no based on agent, tool, server
- **budget** — daily/monthly spend cap per agent or per org
- **rate-limit** — max calls per minute per (agent, tool)
- **time-window** — only allow during business hours (configurable timezone)
- **approval-required** — denial that moves to pending_approval queue

### Phase 2

- **amount-threshold** — calls over R$X require approval; over R$Y are denied outright
- **recipient-allowlist / denylist** — pix recipients, webhook URLs, shipping destinations
- **country-restrictions** — e.g., no payments to OFAC countries
- **mandate-required** — specific tools require a valid mandate before execution
- **velocity** — max total amount per hour across all calls
- **geography** — client IP country must match user's declared country (anti-account-takeover)

### Phase 3 (requires ML)

- **risk-score** — deny if provider-specific risk model > threshold
- **anomaly** — block if call pattern is 3σ+ from user's baseline
- **counterparty-reputation** — BACR-driven seller trust scores

---

## 7. Mandate flow (hybrid AP2)

Three usage patterns, in order of increasing agent autonomy:

### 7a. No mandate (default)

Agent calls `session.execute("codespar_pay", {amount: 50})`. No mandate required. Guardrails evaluates policy rules only. This is fine for small amounts / known-good agents.

### 7b. Mandate-protected call

Agent includes `mandate_id` in the call metadata:

```ts
await session.execute("codespar_pay", {
  amount: 2500,
  currency: "BRL",
  method: "pix",
  recipient: "maria@example.com",
}, { mandateId: "mnd_abc123" });
```

Guardrails:
1. Loads `mnd_abc123` from DB (org-scoped lookup)
2. Verifies HMAC signature against stored secret
3. Checks `expiresAt` not passed
4. Checks `amount` fits in `maxAmount`
5. Checks `agentId` matches
6. Decrements remaining amount atomically in DB
7. On success: records `mandate_consumptions` row linking the call to the mandate

If any check fails → deny with reason. If all pass but policy rules deny on top → deny (mandate doesn't override rules).

### 7c. Delegation (high autonomy)

User creates a `delegation` mandate via dashboard: "agent X can spend up to R$5000 total, max R$500 per call, expires in 7 days". Agent now runs autonomously within those bounds.

Every call consumes from the mandate. `GET /v1/mandates/:id` shows remaining balance. Expiry or cancellation invalidates future consumption.

### 7d. Third-party AP2 mandates (future)

An agent running on platform Y generates an AP2-compatible mandate, submits it to us via `POST /v1/mandates/import` with attestation from their platform. We verify the attestation chain and trust the mandate just as if we'd issued it. **This is the interop play** — makes CodeSpar a destination for agents built elsewhere.

Not in scope for V1. Mention it for roadmap visibility.

---

## 8. Storage schema (new migrations)

```sql
-- Migration 0008: policy_rules
CREATE TABLE policy_rules (
  id              text PRIMARY KEY,              -- pol_<nanoid>
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  type            text NOT NULL,                 -- allow|deny|budget|rate-limit|time-window|approval-required|amount-threshold|...
  priority        int NOT NULL DEFAULT 100,
  enabled         boolean NOT NULL DEFAULT true,
  agents          text[] NOT NULL DEFAULT ARRAY['*']::text[],
  tools           text[] NOT NULL DEFAULT ARRAY['*']::text[],
  servers         text[] NOT NULL DEFAULT ARRAY['*']::text[],
  config          jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_rules_org_enabled_idx ON policy_rules(org_id, enabled);
CREATE INDEX policy_rules_priority_idx ON policy_rules(priority DESC);

-- Migration 0009: policy_evaluations (audit log)
CREATE TABLE policy_evaluations (
  id                 bigserial PRIMARY KEY,
  org_id             text NOT NULL,
  session_id         text NOT NULL,
  user_id            text NOT NULL,
  agent_id           text,
  kind               text NOT NULL,              -- execute|proxy_execute
  tool_name          text NOT NULL,
  server_id          text NOT NULL,
  endpoint           text,                        -- null for execute
  decision           text NOT NULL,              -- allow|deny|pending_approval
  reason             text NOT NULL,
  matched_rule_id    text,
  risk_score         int,
  estimated_cost_usd numeric(10,2),
  amount             numeric(12,2),
  currency           text,
  context            jsonb,                       -- full PolicyContext for debugging
  evaluated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_evaluations_org_time_idx ON policy_evaluations(org_id, evaluated_at DESC);
CREATE INDEX policy_evaluations_session_idx ON policy_evaluations(session_id);
CREATE INDEX policy_evaluations_decision_idx ON policy_evaluations(decision);

-- Migration 0010: mandates
CREATE TABLE mandates (
  id                 text PRIMARY KEY,           -- mnd_<nanoid>
  org_id             text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  authorized_by      text NOT NULL,              -- user_id who approved
  agent_id           text NOT NULL,
  type               text NOT NULL,              -- payment|subscription|delegation
  amount             numeric(12,2) NOT NULL,
  currency           text NOT NULL,
  max_amount         numeric(12,2),              -- only for delegation
  remaining_amount   numeric(12,2) NOT NULL,     -- starts = amount, decremented atomically
  description        text NOT NULL,
  conditions         jsonb,                       -- array of condition objects
  signature          text NOT NULL,              -- HMAC-SHA256
  status             text NOT NULL DEFAULT 'active',  -- active|consumed|revoked|expired
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  consumed_at        timestamptz
);
CREATE INDEX mandates_org_agent_idx ON mandates(org_id, agent_id) WHERE status = 'active';
CREATE INDEX mandates_expires_idx ON mandates(expires_at) WHERE status = 'active';

-- Migration 0011: mandate_consumptions
CREATE TABLE mandate_consumptions (
  id              bigserial PRIMARY KEY,
  mandate_id      text NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  session_id      text NOT NULL,
  tool_call_id    text,                           -- link to session_tool_calls or session_proxy_calls
  amount_consumed numeric(12,2) NOT NULL,
  consumed_at     timestamptz NOT NULL DEFAULT now()
);

-- Migration 0012: pending_approvals
CREATE TABLE pending_approvals (
  id              text PRIMARY KEY,              -- app_<nanoid>
  org_id          text NOT NULL,
  session_id      text NOT NULL,
  user_id         text NOT NULL,
  request         jsonb NOT NULL,                 -- the original execute/proxy_execute body
  context         jsonb NOT NULL,                 -- PolicyContext
  matched_rule_id text,
  status          text NOT NULL DEFAULT 'pending', -- pending|approved|denied|expired
  approver_user_id text,
  decided_at      timestamptz,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL             -- default +15min
);
CREATE INDEX pending_approvals_org_status_idx ON pending_approvals(org_id, status);
CREATE INDEX pending_approvals_expires_idx ON pending_approvals(expires_at) WHERE status = 'pending';
```

---

## 9. API endpoints (new)

All org-scoped via bearer auth.

### Policy rules (CRUD)
- `GET /v1/policies` — list rules for org
- `POST /v1/policies` — create
- `GET /v1/policies/:id`
- `PATCH /v1/policies/:id`
- `DELETE /v1/policies/:id`
- `POST /v1/policies/:id/test` — dry-run against a sample context, returns decision without recording

### Evaluations (read-only audit)
- `GET /v1/evaluations` — list recent decisions (filter by decision, session, tool, time range)
- `GET /v1/evaluations/:id` — full context + matched rule

### Mandates
- `GET /v1/mandates` — list
- `POST /v1/mandates` — create (from dashboard or programmatic)
- `GET /v1/mandates/:id`
- `POST /v1/mandates/:id/revoke`
- `POST /v1/mandates/import` — future, AP2 interop

### Approvals
- `GET /v1/approvals` — list pending for org
- `POST /v1/approvals/:id/approve` — approver decides yes
- `POST /v1/approvals/:id/deny` — approver decides no
- `GET /v1/approvals/:id/status` — agent polls this (or we push via SSE) to know when to proceed

### Modified existing endpoints
- `POST /v1/sessions/:id/execute` — new responses: 403 `policy_denied`, 202 `pending_approval` with `{approval_id, poll_url}`
- `POST /v1/sessions/:id/proxy_execute` — same as above

---

## 10. Integration into `proxy_execute` handler — rough code sketch

```ts
// inside POST /v1/sessions/:id/proxy_execute, after session/quota checks,
// BEFORE credentials resolve

const policyCtx = await buildPolicyContext(sql, {
  ctx, session, request: parsed.data,
});

const decision = await evaluatePolicy(sql, policyCtx);

// Record every evaluation, regardless of decision
await sql`
  INSERT INTO policy_evaluations
    (org_id, session_id, user_id, agent_id, kind, tool_name, server_id,
     endpoint, decision, reason, matched_rule_id, risk_score,
     estimated_cost_usd, amount, currency, context)
  VALUES (...)
`;

if (decision.kind === "deny") {
  reply.code(403);
  return {
    error: "policy_denied",
    reason: decision.reason,
    matched_rule: decision.matchedRule?.id,
    evaluation_id: decision.evaluationId,
  };
}

if (decision.kind === "pending_approval") {
  const approval = await createPendingApproval(sql, policyCtx, decision);
  reply.code(202);
  return {
    status: "pending_approval",
    approval_id: approval.id,
    poll_url: `/v1/approvals/${approval.id}/status`,
    expires_at: approval.expires_at,
  };
}

// decision.kind === "allow" — proceed with credentials resolve + executor
```

---

## 11. Dashboard UX (codespar-web)

The Policies page (`/dashboard/policies`) already exists as a shell. Needs to become:

- **Rule list** with drag-to-reorder (priority), enable/disable toggle
- **Rule editor** — form per rule type with helpful inline docs
- **Test tab** — paste a sample context, see what would happen
- **Evaluations log** — table of recent decisions, filter by decision/tool/time
- **Pending approvals** — inbox with approve/deny buttons, Slack integration

**Mandate page** (new `/dashboard/mandates`):
- Create mandate form
- Active mandates list with remaining amount progress bar
- Revoke button
- Audit log per mandate

---

## 12. Phased delivery

### Phase 1 — Foundation (2-3 sessions)
Goal: policy engine wired into API with basic rules. No mandates yet.
- Migrations 0008 (policy_rules) + 0009 (policy_evaluations)
- Move `PolicyEngine` from Map → Postgres (loads rules per org per request, caches with TTL)
- `buildPolicyContext` helper extracting from session + request
- Integration in `/execute` and `/proxy_execute`
- CRUD routes `/v1/policies`
- Deny responses with `evaluation_id`

### Phase 2 — Approval workflow (2 sessions)
Goal: `approval-required` rule type works end-to-end.
- Migration 0012 (pending_approvals)
- `approval-required` rule type produces 202
- Approval CRUD routes
- Dashboard inbox page
- Slack/email webhook on new pending approval

### Phase 3 — Mandates (2-3 sessions)
Goal: AP2 mandate verification in the request path.
- Migrations 0010 (mandates) + 0011 (mandate_consumptions)
- Move `MandateGenerator` from Map → Postgres
- Mandate CRUD routes
- `mandate_id` in request metadata, verified in Guardrails
- Atomic remaining_amount decrement (SELECT FOR UPDATE or advisory lock)
- Dashboard mandate page

### Phase 4 — Advanced rules (1-2 sessions)
Goal: amount-threshold, recipient-allowlist, velocity.
- New rule types in engine
- Per-meta-tool body extractors for amount/recipient/country
- Test coverage for each rule type

### Phase 5 — Risk + AP2 interop (later)
Goal: learned risk scores + third-party mandate import.
- Risk model (MVP: static per server; later: from BACR dataset)
- `POST /v1/mandates/import` with attestation chain
- Documentation of AP2 wire spec we implement

---

## 13. What makes this moat-worthy

Three compounding effects:

1. **Every evaluation trains us.** `policy_evaluations` accumulates the full ground truth of what agents try to do and how we decide. Competitors start from zero.

2. **Policy defaults get smarter.** New orgs get a preset policy (e.g., "Brazilian Pix with anti-fraud") calibrated from aggregated decisions across all orgs. That's a retention play: leaving CodeSpar means rebuilding policy from scratch.

3. **Provider reputation via decisions.** When we deny "too-high amount to seller X", that signal aggregates across orgs into a seller trust score. Feeds directly into BACR ranking. Users of CodeSpar get fraud protection nobody else can offer.

---

## 14. Non-goals (explicit)

- **Not a general IAM replacement.** Guardrails governs agent tool use, not human auth. That stays Clerk.
- **Not a payment fraud engine.** We leverage providers' fraud signals (Stripe Radar, etc.); we don't replace them.
- **Not a substitute for provider limits.** Guardrails runs *before* providers' own limits. Users still hit Stripe's rate limit if they go over — we just add ours on top.
- **Not a real-time content filter for LLM output.** We evaluate actions, not natural language.

---

## 15. Open questions for Daniel

1. **Rules UX:** DSL (write rules as code like OPA/Rego) or form-based (what we have today)? Form first, DSL later is my instinct; happy to debate.
2. **Atomic mandate consumption:** advisory lock or `SELECT … FOR UPDATE`? Lock is cheaper, `FOR UPDATE` is more standard.
3. **Approval notifications:** Slack webhook, email, dashboard inbox — all three? Priorities?
4. **Default rules for new orgs:** do we ship with a "sensible defaults" policy, or empty? Marketing argues for defaults (onboarding UX); security argues for empty (explicit opt-in).
5. **AP2 interop:** do we commit to supporting third-party AP2 mandates on the spec, or start CodeSpar-native and add interop later?

---

## 16. References

- AP2 spec: https://github.com/ap2-protocol/ap2 (public draft)
- Our AP2 primitives already built: `codespar-enterprise/packages/mandate`
- Policy engine existing code: `codespar-enterprise/packages/policy-engine`
- Payment gateway existing code: `codespar-enterprise/packages/payment-gateway` (uses engine + mandate internally, but not wired to API)

---

**Last updated:** 2026-04-19. Pre-Marco 4 planning.
