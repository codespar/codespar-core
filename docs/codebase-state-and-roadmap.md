# CodeSpar — codebase state & roadmap

Snapshot do que está em produção, o que está em dev, o que ficou pra
trás e o que vem. Data de corte: **2026-04-21**.

Leia depois: [`tool-router-and-bacr.md`](./tool-router-and-bacr.md)
pro conceito de Tool Router; [`guardrails-ap2.md`](./guardrails-ap2.md)
pra o próximo marco proprietário grande; [`custom-session-runtime.md`](./custom-session-runtime.md)
pra entender como os adapters falam com o runtime.

---

## 1. Quatro repos

| Repo | Visibilidade | Stack | O que tem |
|------|--------------|-------|-----------|
| **`codespar-core`** | pública (MIT) | Turborepo + TypeScript ESM + Hatch (Python) | SDK TS (`@codespar/sdk`), **SDK Python (`codespar` no PyPI)**, CLI (`@codespar/cli`), adapters (claude, openai, vercel, mcp, langchain, etc.), **`@codespar/types` + `@codespar/managed-agents-adapter`** (F4.M1 — session contract compartilhado) |
| **`codespar-enterprise`** | privada (commercial) | Turborepo + Fastify + Postgres (Railway) | API backend (`/v1/*`), policy-engine, secrets-vault, mandate, payment-gateway, payment-router, compliance, **2-level tenancy (F-series)** |
| **`codespar-web`** | privada | Next.js 15 (App Router) + Fumadocs | Marketing site, dashboard com routing scoped (`/dashboard/projects/[projectId]/...`), docs, blog |
| **`codespar-opensource`** | pública (MIT) | Turborepo + TypeScript + Docker | **Runtime MIT post-pivot** — channel adapters (WhatsApp, Slack, Telegram, Discord, CLI), tenancy 2-level (Layers 1-4 shipped), channel_links routing. Canonical sibling do managed tier; Daniel toca se precisar runtime self-hostable. |

**Publicados:**
- npm: `@codespar/sdk@0.3.x`, `@codespar/cli@0.2.1+`, `@codespar/types`, `@codespar/managed-agents-adapter`, adapters em 0.2+/0.3
- PyPI: `codespar@0.1.1` (sync + async, mesmo wire contract da SDK TS, OIDC trusted publishing)

---

## 2. codespar-core — estado atual

### 2.1 `@codespar/sdk` (packages/core)

**O que existe:**
- `CodeSpar` class com constructor validando `csk_...`
- `cs.create(userId, config)` → `Session` com `tools()`, `findTools(intent)`,
  `execute(tool, params)`, `loop(config)`, `send(message)`, `sendStream(message)`,
  `proxyExecute(request)`, `authorize(serverId, config)` ← OAuth Connect Links reais, `connections()`, `close()`
- `projectId` em `CodeSparConfig` + `SessionConfig` (session > client > org default).
  Regex `/^prj_[A-Za-z0-9]{16}$/` validada por Zod. Header `x-codespar-project`
  enviado na session create e nas headers do transporte MCP.
- Parser SSE pro `sendStream`; typed `StreamEvent` discriminated union.
- 19 testes unitários (mock de fetch)

**O que falta:**
- Retry policy automática em `execute` (hoje o loop tem, `execute` não)
- Streaming de `proxyExecute` (hoje é one-shot)

### 2.2 `codespar` (packages/python) — Python SDK v0.1.1

Shipped abril/2026. Mesmo wire contract da SDK TS; published no PyPI via
GitHub Actions + OIDC trusted publishing (sem long-lived token).

- `CodeSpar` (sync, blocking wrapper) + `AsyncCodeSpar` (canonical).
- Typed dataclasses espelhando o shape TS (`SessionConfig`, `ToolResult`,
  `StreamEvent`, …).
- `send_stream` como `Iterator` / `AsyncIterator` com pattern match no
  `event.type`.
- `proxy_execute`, `authorize`, `connections`, `close`.
- PEP 561 `py.typed` marker (mypy/pyright enxergam os types).
- Python 3.10+, `httpx` como única runtime dep.
- 20 tests (`pytest-httpx`), ruff + mypy strict clean.
- 5 exemplos runnable em `packages/python/examples/`.

### 2.3 `@codespar/types` + `@codespar/managed-agents-adapter` (F4.M1)

Separados pra reforçar o contract. `@codespar/types` tem `SessionBase`
(5 métodos runtime-agnósticos) estendido por `Session` (+ `proxyExecute`,
`authorize`, `mcp` opcional). Zero deps. Eager-factory pattern no adapter
garante `session.id` estável desde construção. Conformance test suite no
próprio pacote pra validar qualquer custom runtime.

Ver [`custom-session-runtime.md`](./custom-session-runtime.md).

### 2.4 `@codespar/cli` (packages/cli)

- 10 comandos: `login`, `logout`, `whoami`, `servers list/show`, `tools list/show`, `execute`, `sessions list/show/close`, `connect list/start/revoke`, `logs tail`, `init`
- Config em `~/.codespar/config.json`, env vars, flags.
- 4 templates de `init`.
- SSE streaming em `logs tail`.

**Gaps:**
- `connect start` — hoje chama `/v1/connect/start` real do backend 3c, mas o CLI
  não abre o browser automaticamente ainda.
- `logs tail` — aponta pra `/v1/logs/stream` que ainda não existe (endpoint novo).
- Templates não fazem `npm install` dentro.

### 2.5 Adapters (packages/{claude, openai, vercel, langchain, mcp, ...})

Padrão: `getTools(session)` que converte `session.tools()` no formato do framework.
`@codespar/claude` e `@codespar/openai` têm `handleToolCall`. `@codespar/mcp`
expõe `getMcpConfig(session)` + helpers pra Claude Desktop / Cursor.

**Drift conhecida**: `mastra`, `langchain`, `letta`, `camel`, `llama-index`,
`crewai`, `google-genai`, `autogen` descrevem `cs.sessions.create(...)` — **API
que não existe em `packages/core`**. Pre-existing drift; CLAUDE.md autoriza
fix quando já editar os arquivos pra outra coisa.

---

## 3. codespar-enterprise — estado atual

### 3.1 F-series — 2-level tenancy shipped

Marcos F.1 → F.5 adicionaram o modelo Organization → Project em toda a
stack. Summary:

| Marco | O que shipou |
|---|---|
| **F.1** | `projects` table + `/v1/projects` CRUD + backfill 1 default por org |
| **F.2** | `project_id` em todas as 10 tabelas scoped (sessions, tool_calls, proxy_calls, triggers, deliveries, events, connected_accounts, secrets, oauth_state, api_keys). Fix de 2 leaks reais (fanOutToTriggers + retryFailedDeliveries). 305 testes. |
| **F.3** | Dashboard routing project-scoped (`/dashboard/projects/[projectId]/...`). Project Switcher, Cards grid, Bridge routes pra URLs unscoped. |
| **F.5** | Migration 0015 flipped `project_id NOT NULL` + drop legacy indexes. Aplicada manual em prod via railway ssh + registered hash em `schema_migrations`. |

Auth self-heals: se o org Clerk é novo e não tem default project ainda,
`getOrCreateDefaultProjectId` cria (commit `ddb2c17`) — eliminou 502 no
primeiro login de novos orgs.

**Deferred / documentado no `projects-roadmap.md` do opensource:**
- Opensource NOT NULL flip — bloqueado em 4 design questions.

### 3.2 `packages/api` — o coração

Stack: Fastify 5 + postgres (sql-tag), Zod, tsx em dev, tsc + copy:migrations em build.

**Rotas registradas (`/v1/*`):**

| Grupo | Prefixo | Auth | Rotas |
|-------|---------|------|-------|
| dual | `/v1/servers` | bearer OR service | `GET /` (list, filters), `GET /:id` |
| dual | `/v1/sessions` | bearer OR service | `POST /` (create), `GET /` (list), `GET /:id`, `POST /:id/execute`, `POST /:id/proxy_execute`, `POST /:id/send` (JSON ou SSE), `GET /:id/tool-calls`, `DELETE /:id` |
| dual | `/v1/connections` | bearer OR service | list/get/revoke/delete |
| dual | `/v1/triggers` + `/v1/trigger-deliveries` | bearer OR service | Triggers + delivery attempts. Webhook dispatcher + retry worker em background. |
| dual | `/v1/projects` | bearer OR service | CRUD (list/get/create/update/delete, atomic default promotion) |
| dual | `/v1/events` | bearer OR service | Event publishing + fan-out pra triggers |
| dual | `/v1/connect` | bearer OR service | `POST /start` (OAuth link generation) |
| dual | `/v1/connect/callback/:server_id` | unauth (state token) | OAuth callback handler (Marco 3c) |
| dual | `/v1/tools/search` | bearer OR service | Semantic search no catálogo de tools |
| dual | `/v1/tool-calls` | bearer OR service | Org+project-wide tool-call history (shipped para destravar o sidebar Logs badge + Overview toolCallsLast24h) |
| admin | `/v1/api-keys` | service | CRUD API keys |
| admin | `/v1/usage` | service | Reports pra billing |
| admin | `/v1/billing` | service | Stripe subscription |
| webhook | `/stripe/webhook` | Stripe signature | Fora do `/v1/*` |

**Migrations (0001 → 0015):**

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0001 | `init` | `orgs`, `api_keys`, `servers`, `sessions`, `session_tool_calls`, `triggers`, `usage_events` |
| 0002 | `tool_call_io` | `input` + `output` jsonb em `session_tool_calls` |
| 0003 | `proxy_calls` | `session_proxy_calls` (audit paralelo) |
| 0004 | `connected_accounts` | partial unique em conexões ativas |
| 0005 | `server_endpoints` | `base_url` + auth template; seed `stripe-acp`, `asaas`, `zoop`, `mercado-pago`, `nuvem-fiscal`, `melhor-envio`, `z-api` |
| 0006 | `secrets` | Vault Postgres-backed (AES-256-GCM, per-tenant scrypt key) |
| 0007 | `oauth_state` | State tokens one-shot pra Connect Links |
| 0008 | `server_oauth_configs` | authorize/token URLs por provider |
| 0009 | `events` + `event_deliveries` | Event bus |
| 0010 | `trigger_deliveries` | Webhook delivery attempts |
| 0011 | `dlq_and_autopause` | Dead-letter + auto-pause de triggers broken |
| 0012 | `dedup_and_receipts` | Idempotency keys + delivery receipts |
| 0013 | `delivery_request_trace` | Request URL + sent_at capture pra debug |
| **0014** | `projects` ← **F.1** | `projects` table + nullable `project_id` FK em 10 tabelas + backfill + `channel_links` (para opensource) |
| **0015** | `projects_not_null` ← **F.5** | Flip `project_id NOT NULL`; drop legacy índices |

**Testes:** 305 verdes (vitest). Sem integração com Postgres de teste ainda.

**Feature flags:**
- `PROXY_REQUIRE_CONNECTION=true` — 424 se não houver connected_account ativa
- `PROXY_MODE=real` — pluga `executeProxyReal` (default = real em prod, mock em dev)
- `VAULT_BACKEND=postgres|env` — default Postgres; fallback env quando sql/orgId ausentes
- `RUN_MIGRATIONS_ON_BOOT=true` — migrations no startup

**Env vars:**
- `DATABASE_URL`, `DB_SCHEMA`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `CODESPAR_SERVICE_KEY`, `VAULT_MASTER_KEY`,
  `RUN_MIGRATIONS_ON_BOOT`

### 3.3 `packages/secrets-vault` → migrou pra Postgres

Migration 0006 (Marco 3c) + `packages/api/src/vault.ts`. `put`/`getByRef`/`delete`
com `IS NOT DISTINCT FROM` pro caso null-project (org-level secrets). In-memory
class original só existe pra testes agora.

### 3.4 `packages/policy-engine` + `packages/mandate`

Ainda em memória. Bloqueante pro Guardrails (P0). Ver
[`guardrails-ap2.md`](./guardrails-ap2.md) pra o design.

### 3.5 Outros pacotes (inventário)

| Pacote | Status | Descrição |
|--------|--------|-----------|
| `payment-gateway` | Production | Policy + mandate + route + execute + audit |
| `payment-router` | Production | Routing entre providers, fallback, split, fee optimization |
| `escrow` | Production | Fund holding durante agent task |
| `compliance` | Production | Audit reporting, SOC2/GDPR |
| `commerce-kit` | Production | Presets pra checkout, micropayments, full-commerce, brazilian |
| `self-hosted-runtime` | Beta | Commerce agents local via Claude Messages API + MCP |
| `multi-agent` | Beta | Discovery/checkout/auth/settlement/notification agents |
| `mcp-generator` | Production | Auto-gera MCP servers a partir de API specs |
| `repo-index` | Production | Scan e index de codebases |
| `sentry`, `linear`, `jira` | Production | Connectors |
| `observability`, `drift-detection` | Production | Metrics + config drift |
| `persistence` | Production | Storage adapter |
| `types` | Production | Shared TS interfaces |
| `upgrade-guides` | Production | Migration docs |

---

## 4. codespar-web — estado atual

### 4.1 Docs (`content/docs/`)

Fumadocs notebook. Seções:

| Seção | Pages |
|-------|-------|
| Getting Started | `introduction`, `quickstart`, `cli`, `installation` |
| Concepts | `sessions`, `tools`, `tool-router`, **`projects`** ← novo com F.1, `authentication`, `billing` |
| Reference | `sdk`, `cli`, `mcp`, `claude`, `openai`, `vercel`, **`api/projects`**, endpoints |
| Cookbooks | `ecommerce-checkout`, `pix-payment-agent`, `multi-provider`, `streaming-chat`, `webhook-listener`, `multi-tenant` |
| Guides | `mcp-generator`, `debugging` |

Python SDK snippet visible no `/docs/quickstart` como 4ª opção ao lado dos 3 JS.

### 4.2 Marketing site

Homepage + `/product`, `/open-source`, `/security`, `/about`, `/blog`, `/cli`,
`/pricing`, `/use-cases/[slug]`, `/install`, `/enterprise`. Homepage passou por
rewrite completo (marketing-site-v2, PR #115). SDK section tem duas badges de
install (npm + PyPI) linkando direto.

### 4.3 Dashboard — pós-cleanup pre-pivot

Rota `/dashboard/*`. Clerk auth (com `DEV_AUTH_BYPASS=1` local), Railway backend.

**Páginas canonical** (project-scoped sob `[projectId]/`):
- Sandbox (Custom Agent + cookbooks)
- Sessions, Logs, Triggers, Servers, API Keys
- Project overview (metrics reais via F-series counts)

**Páginas org-level**:
- `/dashboard/projects` (CRUD), `/dashboard/projects/new` (dedicated create page)
- Billing, Getting Started

**Bridge routes** (`/dashboard/<surface>` unscoped): absorve tráfego sem project
context (marketing CTAs, docs links, auth post-redirects) e redireciona pro
default project.

**Deletados no pre-pivot cleanup (batch A, commit `03480eb`):**
- `/dashboard/observability/page.tsx` (1208 linhas, Vercel/Railway/Sentry CI-CD
  observability pre-pivot)
- `agent-diagram.tsx`, `blog/thumbnail.tsx`
- `AgentType` union + spawn mock em `file-tree-data.ts`
- 5 fetchers órfãos em `lib/api.ts`

**Sidebar live badges:** polling de `/api/dashboard/counts` (30s) mostra
contadores reais de Sessions / Logs / Triggers.

---

## 5. Tool Router — estado detalhado (Marcos 1 → 3c + F-series)

### Marco 1 — SDK + docs ✅
**Commits:** `codespar-core@dd303ba`, `codespar-web@4f7dfa8`

### Marco 2 — Backend mock ✅
**Commit:** `codespar-enterprise@cc23cc0`

### Marco 3a — Auth foundation ✅
**Commit:** `codespar-enterprise@9553cbd`

### Marco 3b — HTTP real ✅
**Commit:** `codespar-enterprise@a736bf3`

### Marco 3c — Vault persistente + Connect Links reais ✅
**Commit:** `codespar-enterprise@8788c61`

- Vault em Postgres (migration 0006)
- Connect Links OAuth: `POST /v1/connect/start` + `GET /v1/connect/callback/:server_id`
- Migrations 0007 + 0008 (oauth_state + server_oauth_configs)
- 56 testes novos, 134/134

### F-series — 2-level tenancy ✅
Ver seção 3.1. Commits:
- F.1 `410425d` · F.2 `21fb189` · F.3 `497bd2f` / `99a69ec` · F.5 `a9e15a4`
- Dashboard UX phases (`04a371e` / `79dee55` / `f340b4a`)
- Overview + sidebar + sandbox polish (`3a52d72` / `5c9512a` / `a93c6c6` / `6a35b8e`)
- Pre-pivot cleanup (`03480eb`, `-2388 lines`)
- Docs refresh pass (`158a19a` / `f3fb26f` / `1e4dc7c` / `7bb282f`)

### Python SDK ✅
PyPI `codespar@0.1.0` → `0.1.1`. GitHub Actions `publish-python.yml` via
OIDC. 5 examples em `packages/python/examples/`.

### Próximo grande bloco (não iniciado) — Guardrails / AgentGate

Ver [`guardrails-ap2.md`](./guardrails-ap2.md). Depende de:
- PolicyEngine sair de memória pra Postgres
- Mandate generator sair de memória pra Postgres
- AP2 mandate verification integrada em `/v1/sessions/:id/{execute,proxy_execute}`

---

## 6. Roadmap priorizado

### P0 — Diferenciação
1. **Guardrails proprietários (hybrid AP2)** — doc separado. Bloqueante: PolicyEngine + Mandate em DB.
2. **Team / Billing scoped real** — Stripe + RBAC + seats. Pré-requisito pra cobrar.
3. **Commerce observability** — substitui o page pre-pivot deletado.
   Per-provider transaction success, Pix reconciliation latency, NF-e rejection,
   agent spend. Requer novo endpoint agregação no backend.

### P1 — Tração
4. **Anunciar Python SDK** — LinkedIn/X/Discord BR/comunidades Python LatAm.
5. **Connect Links UI completo** — fluxo end-to-end pros 8 providers seeded.
6. **BACR MVP** — depende de volume do Tool Router.

### P2 — Polish + DX
7. **CLI Fatia B** — `connect start` abre browser, `logs tail` contra
   endpoint real quando ele existir, templates com deps.
8. **SDK Python v0.2** — framework adapters (LangChain Python, Vercel AI
   Python, CrewAI).
9. **Server Action refactor** — migrar Servers/Sessions pages do dashboard de
   client fetch pra Server Actions (pequeno win arquitetural; low ROI hoje).

### P3 — Escala
10. `/v1/logs/stream` SSE backend (destrava CLI `logs tail`)
11. Redis-backed rate limiter (horizontal scaling)
12. Multi-region

---

## 7. Dívidas técnicas conhecidas

- **PolicyEngine + MandateGenerator in-memory** — bloqueia Guardrails.
- **Sem testes de rota integrados** — tudo mock Zod/unit. Postgres de teste é
  projeto separado.
- **Adapter READMEs drift** — `mastra`/`langchain`/`letta`/etc. descrevem
  `cs.sessions.create(...)` que não existe (CLAUDE.md autoriza fix quando já
  editar).
- **`logs tail` CLI aponta pra endpoint que não existe.**
- **Opensource NOT NULL flip deferred** (4 design questions, ver
  `projects-roadmap.md`).
- **`toolCallsLast24h` no dashboard** — hoje usa count da window 24h via
  `/v1/tool-calls?since=<iso>`; mas a implementação usa `limit=500` e assume que
  projeto nunca excede isso num dia. Precisa de agregação server-side real.
- **`/v1/tool-calls` sem paginação robusta** — retorna `next_before` mas não
  tem cursor stable se timestamps colidem.

---

## 8. Onde o Daniel codaria agora

**Curva curta (1-2 sessões):**
- **Guardrails step 1** — PolicyEngine em Postgres. Migration nova,
  CRUD endpoints `/v1/policies`, integration test com Postgres de teste (primeira
  vez, então também instala o infra de testing).

**Médio prazo (2-4 sessões):**
- **Guardrails step 2** — integrar no proxy_execute/execute. Flag
  `GUARDRAILS_ENFORCE=true` + audit log novo.
- **Team / Billing scoped** — Stripe seats + RBAC (pagination deferred até
  termos volume).

**Longo prazo:**
- **BACR MVP** — depois de Guardrails em produção.
- **Commerce observability dashboard** — novo page pós-cleanup.

---

## 9. Convenções

- **Commits**: Conventional Commits. `main` direto por enquanto.
- **Branches**: `feature/*` quando multi-sessão.
- **Testes**: unit + Zod hoje. Integration com Postgres precisa entrar — stack a decidir (testcontainers vs pg-mem vs docker compose).
- **Review**: async PR review, mix de pair em mudanças de superfície pública.

---

## 10. Links úteis

- Repos:
  - https://github.com/codespar/codespar-core (público, MIT, SDK TS + Python)
  - https://github.com/codespar/codespar (público, MIT, runtime + channels)
  - https://github.com/codespar/codespar-enterprise (privado, commercial)
  - https://github.com/codespar/codespar-web (privado)
- Docs: https://docs.codespar.dev
- API (Railway): `https://api.codespar.dev/v1/*`
- Dashboard: https://codespar.dev/dashboard
- npm org: https://www.npmjs.com/org/codespar
- PyPI: https://pypi.org/project/codespar/
- VISION: `codespar-web/docs/visions/VISION-codespar.md` (Accepted 2026-04-19)

---

**Última atualização:** 2026-04-21. F-series completo (F.1 → F.5) + Python SDK
live no PyPI + pre-pivot cleanup + docs refresh pass. Próximo grande bloco:
Guardrails (PolicyEngine em DB + mandate verification).
