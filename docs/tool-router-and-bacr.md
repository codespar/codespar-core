# Tool Router & BACR — onboarding

Dois conceitos que às vezes se confundem, mas são **camadas diferentes** da stack CodeSpar. Este doc separa o que cada um é, o estado atual de cada um, e por que um depende do outro.

---

## 1. Tool Router (plumbing)

O Tool Router é a camada que transforma uma **sessão CodeSpar** num endpoint vivo de execução de tools. Depois que uma sessão existe, o agente pode:

- Executar tools registradas via `session.execute(tool, params)` — o caminho padrão pra qualquer coisa no catálogo.
- Proxiar chamadas HTTP cruas via `session.proxyExecute({ server, endpoint, method, body })` — pra endpoints que ainda não têm tool pré-definida, ou quando o schema dos meta-tools é estreito demais.
- Ser consumido como MCP — a URL da sessão (`session.mcp.url`) é compatível com Claude Desktop, Cursor, VS Code.

**Em todos os casos, credentials ficam no servidor.** O agente só vê o session id; o backend injeta a API key, token OAuth ou certificado certo por provider e loga a chamada.

### Por que existe

Workflows de commerce tocam 3–6 providers. Sem router, o código do agente precisa:

1. Armazenar credential do provider (pesadelo de segurança e compliance).
2. Formatar cada request no shape nativo do provider.
3. Lidar com rate limit, retry e rotação de credential por provider.
4. Logar, auditar e cobrar manualmente.

Com o router, o agente só carrega uma API key CodeSpar de curta duração, chama `session.execute` ou `session.proxyExecute`, e o backend cuida do resto.

### Três formas de chamar uma tool

**1. Meta-tool (default)** — roteia pro melhor provider da região/método de pagamento. Agente não precisa saber se o Pix foi via Asaas, Zoop ou Mercado Pago.

```ts
await session.execute("codespar_pay", {
  method: "pix",
  amount: 15000,
  currency: "BRL",
});
```

**2. Raw provider tool** — quando a abstração do meta-tool é larga demais e você quer o shape exato do provider. Credentials ainda injetadas server-side.

```ts
await session.execute("STRIPE_CREATE_CHARGE", {
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
});
```

**3. Proxy execute (HTTP cru)** — pra qualquer coisa ainda não coberta por tool registrada: endpoints novos de provider, APIs beta, integrações one-off. Backend ainda injeta auth, limita taxa e escreve audit log.

```ts
await session.proxyExecute({
  server: "stripe",
  endpoint: "/v1/charges",
  method: "POST",
  body: { amount: 1000, currency: "usd", source: "tok_visa" },
});
```

### Estado atual (Marcos 1 → 3b)

| Marco | O que ficou | Status |
|-------|-------------|--------|
| **1** | SDK-side: types `ProxyRequest`/`ProxyResult`, método `session.proxyExecute`, docs | ✅ publicado (`@codespar/sdk@0.2.1`) |
| **2** | Backend: rota `POST /v1/sessions/:id/proxy_execute`, migration `0003_proxy_calls`, mocks upstream, schema Zod com guard de path traversal | ✅ em `main` |
| **3a** | Auth foundation: migrations `0004_connected_accounts` + `0005_server_endpoints`, resolver de credentials, rotas `/v1/connections` (list/get/revoke/delete), feature flag `PROXY_REQUIRE_CONNECTION` | ✅ em `main` |
| **3b** | HTTP real: executor com fetch real, timeout, auth injection via template, vault stub via env vars, rate limiting per-org-per-server, feature flag `PROXY_MODE=real` | 🚧 em andamento |
| **3c** | Vault persistente: `SecretsVault` em DB, Connect Links reais (OAuth flow server-side), rotação de credentials | pendente |

### Arquitetura resumida

```
SDK (session.proxyExecute)
  │
  ▼
POST /v1/sessions/:id/proxy_execute   ← Fastify route, Zod guard, auth bearer
  │
  ├─ loadSessionScoped       (multi-tenant isolation)
  ├─ checkQuota              (billing)
  ├─ resolveCredentials      (Marco 3a — connected_accounts + server_endpoints)
  │     └─ returns CredentialContext { baseUrl, authHeaderTemplate, credentialRef, ... }
  ├─ PROXY_MODE == real
  │     └─ executeProxyReal  (Marco 3b — real HTTP fetch, auth injection, timeout)
  │           └─ dereferenceCredential(credentialRef)
  │                 └─ env lookup (3b) | vault decrypt (3c)
  └─ PROXY_MODE == mock
        └─ executeProxyMock  (Marco 2 — canned responses per server/endpoint)
  │
  ▼
INSERT INTO session_proxy_calls     (audit log, jsonb body + response)
  │
  ▼
ProxyResult { status, data, headers, duration, proxy_call_id }
```

### O que o Tool Router **NÃO** é

- Não é um search de tools — isso é `session.findTools(intent)` e acontece no SDK, não no backend.
- Não é um roteador inteligente de intents — isso é **BACR**, camada acima.
- Não é um registry de tools — o catálogo vive em `/v1/servers`.

---

## 2. BACR — Best Agent Commerce Route (intelligence)

Análogo ao **best execution** em trading de equities. Dado um **intent** ("comprar 500 unidades de SKU X, entregar em SP, abaixo de R$Y"), roteamos em tempo real através de múltiplos **sellers**, **gateways** e **providers de logística**, otimizando:

- Preço
- Velocidade de entrega
- Disponibilidade
- Risco de fraude

Isso exige inputs que o agente sozinho não consegue construir:

- **Fill rate histórico** por seller
- **Dados de dispute / chargeback** por seller
- **Modelos de pricing dinâmico**
- **SLA tracking** por provider

### O moat

A intelligence do BACR depende do **dataset de execução**. Mais volume roteado → melhor BACR. Um competidor novo começa do zero. Classic data network effect.

### Por que depende do Tool Router

BACR precisa de telemetria de execução pra treinar. Essa telemetria vem de cada chamada logada em `session_proxy_calls` e `session_tool_calls`. Sem volume no Tool Router, BACR não tem sinal.

Sequência correta:
1. **Tool Router** vira plumbing estável (3b + 3c).
2. Clientes integram, volume começa a fluir.
3. Dataset de execução acumula (fill rates reais, latências por provider, disputes).
4. **BACR** entra como endpoint novo — provavelmente `POST /v1/sessions/:id/route` que aceita um intent spec e retorna plano de execução ótimo.

### O que BACR **NÃO** é

- Não é o Tool Router com nome bonito — Tool Router faz **execução** de uma chamada específica. BACR **escolhe** qual chamada fazer.
- Não é feito hoje — é produto diferenciado, registrado no backlog.
- Não é um simples A/B test entre providers — usa modelos preditivos sobre dataset proprietário.

---

## 3. Onde cada coisa vive no repo

### `codespar-core` (público, MIT)

- `packages/core/src/types.ts` — `ProxyRequest`, `ProxyResult`, `HttpMethod`
- `packages/core/src/session.ts` — `session.proxyExecute()` implementation
- `packages/core/src/__tests__/codespar.test.ts` — 14 testes (incluindo proxy)
- `packages/cli/` — `@codespar/cli` publicado no npm (`codespar execute`, `codespar connect list`, etc.)

### `codespar-enterprise` (privado, commercial)

- `packages/api/src/routes/sessions.ts` — `POST /sessions/:id/proxy_execute`
- `packages/api/src/routes/connections.ts` — CRUD `/v1/connections` (Marco 3a)
- `packages/api/src/credentials.ts` — `resolveCredentials`, `formatAuthHeader`
- `packages/api/src/proxy-executor.ts` — HTTP client real (Marco 3b, em dev)
- `packages/api/src/meta-tools.ts` — `executeMetaToolMock`, `executeProxyMock`
- `packages/api/src/migrations/` — `0003_proxy_calls`, `0004_connected_accounts`, `0005_server_endpoints`
- `packages/secrets-vault/` — AES-256-GCM vault (Map in-memory; Marco 3c moves to DB)

### `codespar-web` (privado)

- `content/docs/concepts/tool-router.mdx` — doc pública do conceito
- `content/docs/concepts/sessions.mdx`, `tools.mdx`, `authentication.mdx` — contexto relacionado

---

## 4. Feature flags ativas

| Flag | Default | Efeito |
|------|---------|--------|
| `PROXY_REQUIRE_CONNECTION` | `false` | Quando `true`, proxy_execute retorna 424 se não houver `connected_accounts` ativa. Senão, log do resolve result sem bloquear. |
| `PROXY_MODE` | `mock` | `real` pluga o `executeProxyReal` (Marco 3b). Roll-out gradual por server vem com Marco 3c. |

---

## 5. Próximos passos (ordem recomendada)

1. **Fechar Marco 3b** (HTTP real + rate limit + vault stub via env).
2. **Marco 3c** (vault persistente em DB + Connect Links OAuth reais).
3. **Guardrails proprietários** (policy engine sobre `proxy_execute` — hybrid AP2). P0 estratégico.
4. **BACR MVP** — só depois que 3c estiver em produção por algumas semanas e houver dataset mínimo.

---

## 6. Comandos úteis

```bash
# SDK + adapters
cd codespar-core && npm install && npx turbo run typecheck test

# API backend
cd codespar-enterprise/packages/api && npm install && npx vitest run

# Rodar migrations contra Postgres local
cd codespar-enterprise/packages/api && npm run migrate:dev

# CLI em dev
cd codespar-core/packages/cli && npm run build && node dist/index.js --help
```

---

## 7. Perguntas em aberto (pro Daniel)

- **Rate limiting**: token bucket in-memory (Marco 3b) ou já começar com Redis? In-memory funciona em instância única; Redis é mandatório quando horizontalizar.
- **Vault**: AWS KMS + DB, ou manter o AES-256-GCM local com master key em env? Segundo caminho é mais simples, mas KMS vira requisito quando for SOC2.
- **Connect Links**: o fluxo OAuth completo é grande (redirect URI signed, state param, callback handler, refresh token rotation). Vale uma sessão dedicada antes de começar?
- **BACR**: quais dimensões otimizar primeiro? Preço + fill rate são óbvias; fraud risk e SLA são mais sutis.
