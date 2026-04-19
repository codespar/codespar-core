# CodeSpar — codebase state & roadmap

Snapshot do que está em produção, o que está em dev, o que ficou pra trás e o que vem. Data de corte: **2026-04-19**.

---

## 1. Quatro repos

| Repo | Visibilidade | Stack | O que tem |
|------|--------------|-------|-----------|
| **`codespar-core`** | pública (MIT) | Turborepo + TypeScript ESM | SDK (`@codespar/sdk`), CLI (`@codespar/cli`), adapters (claude, openai, vercel, mcp, langchain, etc.) |
| **`codespar-enterprise`** | privada (commercial) | Turborepo + Fastify + Postgres (Railway) | API backend (`/v1/*`), policy-engine, secrets-vault, mandate, payment-gateway, payment-router, compliance, 20 pacotes total |
| **`codespar-web`** | privada | Next.js 15 (App Router) + Fumadocs | Marketing site, dashboard, docs (MDX), blog |
| **`codespar-opensource`** | pública (MIT) | Turborepo + TypeScript + Docker | Produto **legado** pré-pivot: autonomous agents para WhatsApp/Slack/Discord/Telegram. Não é onde investimos energia. Mantido pela marca OSS + compat com ferramentas internas. Daniel normalmente não toca. |

Publicados no npm: `@codespar/sdk@0.2.0`, `@codespar/cli@0.2.1`, adapters em `0.2.0`.

---

## 2. codespar-core — estado atual

### 2.1 `@codespar/sdk` (packages/core)

**O que existe:**
- `CodeSpar` class com constructor validando API key (`csk_live_...` ou env `CODESPAR_API_KEY`)
- `cs.create(userId, config)` → cria sessão no backend, retorna `Session`
- `Session` com métodos: `tools()`, `findTools(intent)`, `execute(tool, params)`, `loop(config)`, `send(message)`, `sendStream(message)`, `proxyExecute(request)` ⬅ Marco 1 novo, `authorize(serverId)` (stub, Marco 3), `connections()`, `close()`
- Types: `SessionConfig`, `Tool`, `ToolResult`, `LoopConfig`, `LoopStep`, `LoopResult`, `SendResult`, `StreamEvent`, `ToolCallRecord`, `ProxyRequest`, `ProxyResult`, `HttpMethod`, `AuthConfig`, `AuthResult`, `ServerConnection`
- Parser SSE (`parseSseStream`) em `session.ts` pro `sendStream`
- `SessionConfigSchema` (Zod) pra validar config no constructor
- 14 testes unitários (mock de fetch)

**O que falta:**
- `session.authorize()` real (OAuth flow client-side — coordena com Marco 3c do backend)
- Retry policy automática em `execute` (hoje o loop tem, `execute` não)
- Streaming de `proxyExecute` (hoje é one-shot)

### 2.2 `@codespar/cli` (packages/cli)

**O que existe:**
- 10 comandos: `login`, `logout`, `whoami`, `servers list/show`, `tools list/show`, `execute`, `sessions list/show/close`, `connect list/start/revoke`, `logs tail`, `init`
- Config file em `~/.codespar/config.json` (chmod 600), env vars (`CODESPAR_API_KEY`, `CODESPAR_BASE_URL`), CLI flags (`--api-key`, `--base-url`, `--json`)
- 4 templates de `init`: `pix-agent`, `ecommerce-checkout`, `streaming-chat`, `multi-tenant`
- SSE streaming em `logs tail`
- Color-coded output com detecção de TTY

**O que falta:**
- `connect start` hoje é mock — não dispara OAuth real (depende do Marco 3c do backend)
- `logs tail` aponta pra `/v1/logs/stream` que ainda não existe no backend (endpoint novo)
- Templates com deps reais (hoje têm `package.json` estáticos; não fazem `npm install` dentro do template)

### 2.3 Adapters (packages/{claude, openai, vercel, langchain, mcp, ...})

Todos seguem o mesmo padrão: função `getTools(session)` que converte `session.tools()` no formato nativo do framework. `@codespar/claude` e `@codespar/openai` também têm `handleToolCall`. `@codespar/mcp` expõe `getMcpConfig(session)` + helpers de config pra Claude Desktop / Cursor.

Todos `0.2.0`, typecheck limpo, mock de `Session` completo (inclui `proxyExecute` como noop).

---

## 3. codespar-enterprise — estado atual

### 3.1 `packages/api` — o coração

Stack: Fastify 5 + postgres (sql-tag), Zod, tsx em dev, tsc + copy:migrations em build.

**Rotas registradas (`/v1/*`):**

| Grupo | Prefixo | Auth | Rotas |
|-------|---------|------|-------|
| dual (bearer ou service) | `/v1/servers` | bearer OR service | `GET /` (list, filter category/country/q), `GET /:id` |
| dual | `/v1/sessions` | bearer OR service | `POST /` (create), `GET /` (list), `GET /:id`, `POST /:id/execute`, `POST /:id/proxy_execute` ⬅ Marco 2, `POST /:id/send` (content-negotiated JSON ou SSE), `GET /:id/tool-calls`, `DELETE /:id` (close) |
| dual | `/v1/connections` ⬅ Marco 3a | bearer OR service | `GET /` (list, filter user/server/status), `GET /:id`, `POST /:id/revoke`, `DELETE /:id` |
| dual | `/v1/triggers` | bearer OR service | CRUD; entrega real (HTTP POST pro webhook_url) não implementada |
| admin (service only) | `/v1/api-keys` | service | CRUD de API keys |
| admin | `/v1/usage` | service | Reports de uso pra billing |
| admin | `/v1/billing` | service | Stripe subscription management |
| webhook | `/stripe/webhook` | Stripe signature | webhook handler fora do `/v1/*` |

**Módulos internos (`src/`):**
- `server.ts` — factory Fastify, registra CORS + health + webhook + `/v1/*`
- `auth.ts` — `requireBearerOrService`, `requireServiceAuth` plugins
- `billing.ts` — `checkQuota(sql, orgId)` → `{ allowed, plan, limit, used }`
- `credentials.ts` ⬅ Marco 3a — `resolveCredentials()`, `formatAuthHeader()`
- `meta-tools.ts` — `COMMERCE_META_TOOLS` (as 6 meta-tools), `executeMetaToolMock`, `executeProxyMock` ⬅ Marco 2, `getMetaTool`
- `proxy-executor.ts` ⬅ Marco 3b (em dev) — HTTP client real, URL builder, header injection, timeout, error mapping
- `db.ts` — `getDb()` retorna instância `postgres()` singleton
- `env.ts` — validação de env vars com Zod
- `keys.ts` — geração e hash de API keys (`csk_live_...` + SHA-256)
- `migrate.ts` — runner de migrations com pg_advisory_lock (key `727374`)

**Migrations:**

| # | Arquivo | O que faz |
|---|---------|-----------|
| 0001 | `0001_init.sql` | Schema inicial: `orgs`, `api_keys`, `servers`, `sessions`, `session_tool_calls`, `triggers`, `usage_events`, `schema_migrations` |
| 0002 | `0002_tool_call_io.sql` | Adiciona colunas `input jsonb` e `output jsonb` em `session_tool_calls` |
| 0003 | `0003_proxy_calls.sql` ⬅ Marco 2 | Tabela `session_proxy_calls` (audit log paralelo ao `session_tool_calls` mas com `method`, `endpoint`, `upstream_status`) |
| 0004 | `0004_connected_accounts.sql` ⬅ Marco 3a | Tabela `connected_accounts` (per org/user/server), partial unique index em `(org_id, user_id, server_id) WHERE status='connected'` |
| 0005 | `0005_server_endpoints.sql` ⬅ Marco 3a | Tabela `server_endpoints` (base_url + auth header template), seed com 8 providers (stripe, asaas, zoop, mercadopago, nuvem-fiscal, melhor-envio, z-api) |

**Testes (`packages/api/src/__tests__/`):**
- `proxy-execute.test.ts` — 11 testes, schema Zod + mock upstream
- `credentials.test.ts` — 7 testes, `formatAuthHeader` helper
- Total 18/18 verde. **Não tem** teste de rota integrado com Postgres de teste ainda — essa infra vem com Marco 3b/3c.

**Feature flags:**
- `PROXY_REQUIRE_CONNECTION=true` — proxy_execute retorna 424 se não houver connected_account ativa
- `PROXY_MODE=real` ⬅ Marco 3b — pluga `executeProxyReal` no lugar do `executeProxyMock`

**Env vars atuais:**
- `DATABASE_URL`, `DB_SCHEMA` — Postgres
- `ANTHROPIC_API_KEY` — pro `/send` endpoint (Claude tool-use loop)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — billing
- `SERVICE_TOKEN` — admin routes
- `VAULT_MASTER_KEY` — usado pelo `secrets-vault` (in-memory hoje)
- `RUN_MIGRATIONS_ON_BOOT=true` — roda migrations no startup

### 3.2 `packages/secrets-vault`

**O que tem:**
- `SecretsVault` class com AES-256-GCM (IV + tag por entrada)
- `scryptSync(masterKey, tenantId, 32)` → derived key por tenant
- `set/get/delete/listKeys/getExpired/rotate`
- **Storage in-memory (Map)** — não persiste

**O que falta (Marco 3c):**
- Tabela `secrets` no Postgres: `id, tenant_id, key, encrypted_value, iv, tag, expires_at, rotation_interval_days, created_at`
- `VaultStore` interface abstraindo Map e Postgres
- Hook de migration automática quando uma credential é usada pela primeira vez
- Background job de reaping expired + rotation

### 3.3 `packages/policy-engine`

**O que tem já hoje (relevante pros Guardrails):**
- `PolicyEngine` class com `rules`, `budgets`, `rateCounts` em memória
- Tipos de rule: `allow | deny | budget | rate-limit | time-window | approval-required`
- Matching por `agents` (array de IDs ou `*`) e `tools` (wildcard `*`, exact, `prefix*suffix`)
- `evaluate(agentId, toolName, estimatedCost?)` → `PolicyDecision { allowed, reason, matchedRule?, budgetRemaining? }`
- `recordUsage(agentId, toolName, cost)` atualiza budget e rate
- Priority sort antes de evaluate

**O que falta** (doc separado `guardrails-ap2.md` detalha):
- Integração na API — hoje o engine vive isolado, não é chamado em `execute`/`proxy_execute`
- Persistence — rules e budgets são in-memory
- Context enriquecido (session metadata, user tier, provider risk score)
- AP2 mandate verification integrada
- Tabela `policy_rules` + `policy_evaluations` (audit) + `agent_budgets`

### 3.4 `packages/mandate` (AP2 primitives)

**O que tem:**
- `MandateGenerator` class com HMAC-SHA256
- Signature cobre: `id + agentId + amount + currency + expiresAt`
- Tipos: `payment | subscription | delegation`
- Campos: `maxAmount` pra delegation, `conditions` array, `expiresAt`, `authorizedBy`
- `create/verify/revoke/list` em Map in-memory

**O que falta:**
- Storage em DB
- Verificação de `conditions` (hoje armazena mas não avalia)
- Integração com `proxy_execute` / `execute` pro fluxo "preciso de mandate pra este valor"

### 3.5 Outros pacotes (inventário rápido)

| Pacote | Status | Descrição |
|--------|--------|-----------|
| `payment-gateway` | Production | Unified payment flow — policy check, mandate verification, route selection, execution, audit |
| `payment-router` | Production | Intelligent routing entre providers com fallback, split logic, fee optimization (Stripe) |
| `escrow` | Production | Fund holding durante agent task, release on completion/approval |
| `compliance` | Production | Audit reporting, SOC2/GDPR checks |
| `commerce-kit` | Production | Presets pra checkout, micropayments, full-commerce, brazilian |
| `self-hosted-runtime` | Beta | Commerce agents local via Claude Messages API + MCP |
| `multi-agent` | Beta | Orchestra discovery/checkout/auth/settlement/notification agents |
| `mcp-generator` | Production | Auto-gera MCP servers a partir de API specs |
| `repo-index` | Production | Scan e index de codebases |
| `sentry`, `linear`, `jira` | Production | Connectors de integração |
| `observability`, `drift-detection` | Production | Metrics + config drift |
| `persistence` | Production | Storage adapter (in-memory dev / Postgres prod) |
| `types` | Production | Shared TS interfaces |
| `upgrade-guides` | Production | Migration docs entre versões |

---

## 4. codespar-web — estado atual

### 4.1 Docs (`content/docs/`)

Estrutura Fumadocs notebook layout. Seções:

| Seção | Pages |
|-------|-------|
| Getting Started | `introduction`, `quickstart`, `cli`, `installation` |
| Concepts | `sessions`, `tools`, **`tool-router`** ⬅ Marco 1, `authentication`, `billing` |
| Reference | `sdk`, `cli`, `mcp`, `claude`, `openai`, `vercel`, endpoints |
| Cookbooks | `ecommerce-checkout`, `pix-payment-agent`, `multi-provider`, `streaming-chat`, `webhook-listener`, `multi-tenant` |
| Guides | `mcp-generator`, `debugging` |

Cada cookbook tem hero component polido (LoopDiagram, PixFlow, RoutingDiagram, StreamingSplit, TenantArch, EventPipeline) com estilo pixel-perfect dos protótipos HTML.

### 4.2 Marketing site

Homepage + `/product`, `/open-source`, `/security`, `/about`, `/blog`, `/cli`, `/enterprise` (teaser). Dark-first, Obsidian `#0D0F17` canvas, Signal Blue `#3B82F6` primary action.

### 4.3 Dashboard

Rota `/dashboard/*`. Clerk auth, Railway backend. Páginas: overview, chat (streaming), agents, canvas (React Flow), audit, settings, setup, team, integrations, policies, observability, secrets, payments, a2a, admin, admin/billing. **Muitas mock ainda** — integração real é incremental.

---

## 5. Tool Router — estado detalhado por Marco

Esse é o foco das últimas 3 sessões. Detalhamento extra porque é o carro-chefe agora.

### Marco 1 — SDK + docs ✅
**Commit:** `codespar-core@dd303ba`, `codespar-web@4f7dfa8`

- Types `ProxyRequest`/`ProxyResult`/`HttpMethod` em `@codespar/sdk`
- `session.proxyExecute(request)` chamando `POST /v1/sessions/:id/proxy_execute`
- 2 testes novos (success + 404 path), 14/14 total green
- `fakeSession` mock em todos os 12 adapters atualizado
- Doc `/docs/concepts/tool-router.mdx` em codespar-web

### Marco 2 — Backend mock ✅
**Commit:** `codespar-enterprise@cc23cc0`

- Migration `0003_proxy_calls` (tabela audit log)
- Rota `POST /v1/sessions/:id/proxy_execute` com Zod guard (path traversal bloqueado via `startsWith("/")` + refine `!includes("..")`)
- Quota enforcement (conta contra mesma mensalidade de `/execute`)
- Validação `session.servers.includes(server)` antes de executar
- `executeProxyMock` com shapes específicos pra stripe (`/v1/charges`, `/v1/customers`) e asaas (`/v3/payments`), fallback genérico
- 11 testes (schema + mock), 18/18 API total

### Marco 3a — Auth foundation ✅
**Commit:** `codespar-enterprise@9553cbd`

- Migration `0004_connected_accounts` — partial unique index em conexões ativas, campos pra OAuth metadata
- Migration `0005_server_endpoints` — base_url + auth_header_template (stripe/asaas/zoop/mercadopago/nuvem-fiscal/melhor-envio/z-api seeded)
- `credentials.ts` — `resolveCredentials(sql, {orgId, userId, serverId})` retorna union discriminado (`ok | server_unknown | not_connected | endpoint_missing`), `formatAuthHeader(template, token)` helper
- Rotas `/v1/connections` — list/get/revoke/delete (POST via OAuth deferido pra Marco 3c)
- Integração no proxy_execute: resolver chamado sempre; flag `PROXY_REQUIRE_CONNECTION=true` liga 424
- 7 testes novos (`formatAuthHeader`), 18/18 API total

### Marco 3b — HTTP real 🚧 em dev

**Status:** `proxy-executor.ts` esqueleto escrito, não commitado ainda. Rota ainda usa só mock.

**O que precisa fechar:**

1. ✅ `proxy-executor.ts` com:
   - `dereferenceCredential(ref)` — lê env `CODESPAR_CRED_<ref>` (normalize ref: uppercase + non-alnum → `_`)
   - `buildUpstreamUrl(baseUrl, endpoint, params, authQueryKey, token)` — strip trailing slash, URL encode params, auth via query opcional
   - `buildUpstreamHeaders(ctx, token, callerHeaders, hasBody)` — auth wins last-write, caller headers lowercased, default Content-Type pra bodied
   - `executeProxyReal(ctx, req)` — fetch com AbortController timeout, parse JSON defensivo (surface raw quando content-type não bate), erro mapping (`AbortError → timeout`, outros → `network_error`)
   - Belt-and-suspenders: se `auth_type != none && !token`, retorna `credential_unavailable` sem chamar fetch

2. ❌ Rate limiter:
   - In-memory token bucket per `(org_id, server_id)` — refill rate configurável por server
   - Retornar 429 com `retry-after` header
   - Postgres advisory lock opcional pra caso de múltiplas instâncias (decisão em aberto)

3. ❌ Wire do `PROXY_MODE=real` no handler (branch entre `executeProxyReal` e `executeProxyMock`)

4. ❌ Testes:
   - `buildUpstreamUrl` — casos de trailing slash, params, authQueryKey
   - `buildUpstreamHeaders` — precedência, case-insensitivity
   - `executeProxyReal` com fetch mockado (vitest `vi.spyOn(globalThis, "fetch")`)
   - Timeout → `error_code: "timeout"`
   - Invalid JSON response → `error_code: "invalid_json"` + raw body em `data`

5. ❌ Commit + push

### Marco 3c — Vault persistente + Connect Links reais 📋 pendente

**Escopo:**

1. **Vault em DB:**
   - Migration `0006_secrets.sql` — tabela `secrets (id, org_id, ref_key, encrypted_value, iv, tag, expires_at, rotation_interval_days, created_at, last_rotated_at)`
   - `VaultStore` interface (impl Map + impl Postgres)
   - `SecretsVault.setStore(store)` pra DI
   - Background job: reap expired, rotation warnings

2. **Connect Links (OAuth flow server-side):**
   - Migration `0007_oauth_state.sql` — tabela `oauth_state (state_token, org_id, user_id, server_id, redirect_uri, created_at, expires_at)` com TTL 10min
   - Rota `POST /v1/connect/start` — recebe `{ server_id, user_id, redirect_uri? }`, retorna `{ link_token, authorize_url }`
   - Rota `GET /v1/connect/callback/:server_id` — recebe `?code=...&state=...`, troca por access+refresh token, guarda no vault, cria `connected_accounts` row
   - Rota `POST /v1/connect/refresh` — refresh token rotation
   - Config por server: `authorize_url`, `token_url`, `scopes`, `client_id/secret` (do vault da org)

3. **Wire fim do `credential_ref`:**
   - Dereference via `SecretsVault.get(orgId, credentialRef)` em vez de env
   - Remove feature flag `PROXY_MODE` (passa a ser sempre real)

4. **Tests:** integration suite completa com Postgres de teste, fixtures de orgs/sessions/connections

### Marco 4 (nome em aberto) — Observability + rate limit real + produção

Depois de 3c estar estável:
- `GET /v1/logs/stream` (SSE) — o CLI já consome (hoje quebra)
- Redis-backed rate limiter (horizontal scaling)
- Alerting (Sentry pra 5xx, Datadog pra latency)
- Deploy scripts (Railway ou K8s)
- Load testing + capacity planning

---

## 6. Roadmap priorizado (próximos 4–6 meses)

### P0 — Diferenciação

1. **Fechar Tool Router 3b + 3c** (este trilho) — 2-3 sessões
2. **Guardrails proprietários (hybrid AP2)** — doc separado `guardrails-ap2.md`. Depende de 3a mínimo. 4-5 sessões.
3. **Webhooks & Triggers** — entrega real de eventos outbound + ingestão inbound de Stripe/Asaas. Bloqueia notificações reais. 2-3 sessões.

### P1 — Expansão

4. **BACR MVP** — depende de volume do Tool Router. Começar depois de Guardrails em produção.
5. **Connect Links completos** — fluxo OAuth end-to-end pros 8 providers do seed.
6. **CLI Fatia B** — `connect start` real, `logs tail` contra endpoint real, templates com deps.

### P2 — Polish e dev experience

7. **Docs Faixa B + C** — enriquecer `/docs/reference` com todos os endpoints, cobrir casos edge, polish visual.
8. **Dashboard páginas reais** — integrations, policies, observability saindo de mock.
9. **READMEs dos outros repos** — `codespar-web`, `codespar-enterprise`, `mcp-brasil`.

### P3 — Escala

10. **Webhooks inbound** (provider → CodeSpar) pra cada integração listada.
11. **Multi-region** (latency otimizada pra LatAm — Railway já é São Paulo).
12. **SDK em outras linguagens** — Python primeiro (maior demanda no mercado de agents).

---

## 7. Dívidas técnicas conhecidas

- **SecretsVault in-memory** — tolerável em Marco 3a, bloqueante em Marco 3c.
- **PolicyEngine in-memory** — mesmo problema, tem que migrar pra DB.
- **MandateGenerator in-memory** — mesmo.
- **`session.authorize()` stub** — devolve `{connected:false, error:...}`. Esperando Marco 3c.
- **Sem testes de rota integrados** — tudo mock Zod/unit. Suite com Postgres de teste é um projeto separado.
- **`logs tail` CLI aponta pra endpoint que não existe** — usuário que tentar rodar recebe 404.
- **`connect start` CLI retorna URL mock** — não dispara OAuth real.

---

## 8. Perguntas práticas pra alinhamento

1. **Onde o Daniel vai codar primeiro?** Sugestão:
   - **Curva curta**: Marco 3b (HTTP client + rate limit) — issue bem delimitada, testa skills em Node/Fastify/Zod/vitest.
   - **Médio prazo**: Marco 3c (OAuth flow + vault) — mexe em segurança e precisa cuidado com refresh tokens + encryption.
   - **Longo prazo**: Guardrails (integração do policy-engine no proxy_execute) — projeto maior, precisa alinhamento de produto.

2. **Ambiente de dev**: Postgres local via Docker? Railway staging? Me diz qual você quer que eu documente.

3. **Convenções de commit + branches**: sigo Conventional Commits e `main` direto. Se o time cresce, `feature/*` + PR vira obrigatório.

4. **Testing philosophy**: hoje é unit + Zod. Integration com Postgres vai ter que entrar — qual stack (testcontainers? pg-mem? Docker compose?) é decisão a fazer.

5. **Code review**: pair programming, async PR review, ou mix?

---

## 9. Links úteis

- Repos:
  - https://github.com/codespar/codespar-core (público, MIT)
  - https://github.com/codespar/codespar-enterprise (privado, commercial)
  - https://github.com/codespar/codespar-web (privado)
  - https://github.com/codespar/codespar-opensource (público, MIT, produto legado)
- Docs (hoje, pode ir mudando): https://codespar.dev/docs
- API (Railway): `https://api.codespar.dev/v1/*`
- Dashboard: https://codespar.dev/dashboard
- npm org: https://www.npmjs.com/org/codespar (pacotes `@codespar/*`)

---

**Última atualização:** 2026-04-19, durante Marco 3b em dev.
