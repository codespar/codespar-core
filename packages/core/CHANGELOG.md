# @codespar/sdk — CHANGELOG

## 0.16.16 — 2026-10-07

### Changed

- Snapshot do OpenAPI relido do documento servido: 299 operacoes viram 340,
  41 rotas novas e nenhuma removida. 62 operacoes mudaram: 56 de forma e 6 so
  de texto. `components.schemas` muda em `Trigger` e em `ServerCatalogRow`.
  Snapshot `942e7981a973`, API 0.3.0.

  Tipos que alargam para `null`: `gateway_url` em mcp-servers e paywalls,
  `pay_url` em payment-links e `webhook_url` em `Trigger` e nas respostas de
  `/v1/triggers/{id}` e `/v1/webhook-endpoints/{id}` passam de `string` a
  `string | null`. Cliente TypeScript que le esses campos como `string` deixa
  de compilar ate tratar o `null`; em runtime nada muda para quem ja recebia
  o valor. Nenhum campo de resposta foi removido.

  Razao de carteira (enterprise #1951): `POST /v1/wallets/{id}/ledger` ganha
  o 409 `fund_requires_test_project`. `kind: "fund"` so e aceito para
  carteira de projeto de teste; fora disso nada e gravado.

  Consentimento bancario vencido (enterprise #1952): `POST /v1/bank-consents`
  e `POST /v1/bank-consents/{id}/callback`, com os alias em
  `/v1/ofb/consents`, documentam que um consentimento alem da janela de
  validade passa a `expired` e deixa de ocupar a vaga do consumidor naquele
  banco. Consentimento `expired` nao pode ser revogado
  (`illegal_transition`). So texto, quatro operacoes.

  O restante vem da enterprise #1955.

  Collect, 20 rotas novas em `/v1/collect`, escopos `collect:read` e
  `collect:write`: links (criar, listar, ler, alterar, rascunho, publicar,
  pausar, retomar, arquivar, `stats`), tentativas, pagamentos, reembolsos,
  recebedores, `test-pay` e `honor`. `GET /v1/collect/{linkId}` e
  `POST /v1/collect/{linkId}/attempts` nao pedem credencial. A familia
  responde 404 `collect_disabled` enquanto o deployment nao a liga.
  `GET /.well-known/codespar-receipt-keys.json` ganha `collect_receipt`,
  obrigatorio. `collect_simulated_settle_refused` entra no 409 de
  `POST /v1/test/charges/{chargeId}/pay` e do alias
  `POST /v1/charges/{chargeId}/sandbox/pay`.

  Medidores, 7 rotas novas, escopos `meters:read` e `meters:write`:

      GET  /v1/meters                    (`period`)
      POST /v1/meters
      GET  /v1/meters/cycle
      GET  /v1/meters/{meterId}
      GET  /v1/meters/{meterId}/usage
      GET  /v1/meters/{meterId}/events
      POST /v1/meter-events              (idempotente em `event_id`)

  Conta, 6 rotas novas:

      GET  /v1/account/payments
      GET  /v1/account/sessions
      GET  /v1/account/test-balance
      POST /v1/account/fund/sandbox           (escopo `consumers:fund`)
      POST /v1/account/fund/sandbox/initial
      POST /v1/account/fund/sandbox/refill

  `GET /v1/account/ledger` aceita `proposal_id` e cada lancamento ganha sete
  campos obrigatorios: `test_funding`, `test_funding_kind`, `proposal_id`,
  `reverses`, `source`, `phase` e `executor`. `GET /v1/account/summary` ganha
  `sessions.active_idle_ms`. `GET /v1/account/agent-activity` admite as
  janelas `24h` e `7d`, e cada agente ganha `tool_calls` e
  `spent_within_mandate_minor`.

  Condicoes e acoes de trigger: `Trigger` ganha `condition` e `action`
  (`webhook`, `human_review`, `pause_agent`), os dois obrigatorios, e
  `webhook_url` passa a anulavel; a criacao deixa de exigir `webhook_url`. As
  linhas da lista ganham `consecutive_failures`, `last_response_status` e
  `last_delivery_at`. Codigos novos: 400 `trigger_condition_invalid` e
  `trigger_action_invalid` no `PATCH`, 409 `trigger_test_fire_webhook_only` no
  test-fire. Doze operacoes, em `/v1/triggers` e em `/v1/webhook-endpoints`.
  Rotas novas, escopo `triggers:read`:

      GET  /v1/triggers/events
      POST /v1/triggers/simulate
      GET  /v1/webhook-deliveries
      GET  /v1/events/summary

  `POST /v1/events/{event_id}/replay` documenta que a condicao da assinatura
  vale tambem no replay. So texto.

  Aprovacoes: as seis leituras e decisoes, em `/v1/approvals` e em
  `/v1/orgs/{orgId}/approvals`, ganham `origin` (`agent` ou `trigger`),
  obrigatorio.

  Disponibilidade do gateway: mcp-servers, paywalls e payment-links, doze
  operacoes, ganham `gateway_unavailable_reason`, obrigatorio e anulavel, e
  `gateway_url` e `pay_url` passam a anulaveis. `GET /v1/discovery/manifest`
  ganha o mesmo motivo. mcp-servers ganham `last_paid_call_at`.

  Conexoes: as cinco leituras e escritas de conexao ganham
  `is_shared_sandbox` e `shared_sandbox_tools`, obrigatorios.
  `POST /v1/connections` ganha o 403 `cdp_self_serve_connect_disabled`. As
  duas rotas de verify-connection ganham `shared_sandbox_operation_refused` e
  `shared_sandbox_credential_not_test`. `ServerCatalogRow` ganha
  `description_pt_br`, `connect_fields` e `connectable`, obrigatorios.
  `GET /v1/servers/{id}/auth-schema` documenta quais tipos de autenticacao
  devolvem campos. So texto.

  Health: `GET /v1/health` ganha o objeto `attention`, obrigatorio, e cada
  verificacao ganha `state`, `required`, `reason` e um `action` opcional.
  Rota nova, so leitura, escopo `connections:read`:

      GET /v1/health/history   (`days`, 1 a 30)

  Sessoes e agentes: `GET /v1/sessions` aceita `agent_id` e cada linha ganha
  `agent_did`, `agent_id` e `tool_calls_count`. `GET /v1/agents` aceita
  `project_id` e cada agente ganha `projects`, obrigatorio. Rotas novas, so
  leitura, escopo `sessions:read`:

      GET /v1/tool-calls/stats   (`window`)
      GET /v1/onboarding         (`project_id`)

  `POST /v1/consumer-payments/execute`, `execute-stream` e
  `POST /v1/consumers/mandates/{id}/spend` aceitam `session_id`, opcional.

  Eventos de auditoria: `GET /v1/audit-events` e o alias
  `GET /v1/audit/events` aceitam `actor_kind` e `project_id`, cada evento
  ganha `actor_person_id`, obrigatorio e anulavel, e o 400 ganha
  `invalid_actor_kind` e `invalid_project_id`.

  Sandbox: rota nova `POST /v1/test/charges/{chargeId}/scenarios`, escopo
  `tools:execute`. `funding_account_not_owned` entra no 403 de
  `POST /v1/consumers/{consumerId}/fund/sandbox` e de `POST /v1/test/fund`.
  `POST /v1/consents/{token}/submit` admite o metodo de atestacao
  `sandbox_fixture` e ganha o 403 `attestation_sandbox_fixture_not_permitted`.

  `GET /v1/mandates/{id}` ganha `funding` (`rail`, `currency`), obrigatorio e
  anulavel. `GET /v1/payables/counts` ganha `overdue`, obrigatorio.

## 0.16.15 — 2026-10-06

### Changed

- Snapshot do OpenAPI relido do documento servido: 295 operacoes viram 299,
  quatro rotas novas e nenhuma removida. 39 operacoes mudaram: 22 de forma e
  17 so de texto. `components.schemas` muda em `PolicyEvaluation` e em
  `Trigger`. Snapshot `338d2d994c62`, API 0.3.0.

  Suspensao de agente (enterprise #1764), rota nova, escopo `agents:write`:

      POST /v1/agents/{did}/suspend   (corpo `reason`)

  So um agente `active` pode ser suspenso (409 `agent_not_suspendable` nos
  outros casos); suspender de novo responde `changed: false`. Enquanto
  suspenso, todo gasto em nome do agente e recusado com 403
  `agent_suspended`. Retomar nao e operacao de chave de API. No mesmo PR,
  `POST /v1/agents/{did}/revoke` passa a documentar que a revogacao alcanca
  todo mandato emitido para o agente, ligado ou nao a chave dele, com a recusa
  `agent_inactive`. So texto.

  Numeros de venda pelo gateway (enterprise #1817), rota nova, so leitura,
  escopos `paywalls:read` e `mcp-servers:read`:

      GET /v1/gate/stats   (`window`, so `30d`)

  `GET /v1/paywalls/{id}/stats` documenta a mesma regra de atribuicao: o
  proposito `paywall:<slug>` E a URL do recurso, dentro da organizacao e do
  projeto do paywall. So texto.

  Pagamentos de payment link (enterprise #1815), rotas novas, so leitura,
  escopo `payment-links:read`:

      GET /v1/payment-links/stats            (`window`, so `30d`)
      GET /v1/payment-links/{id}/payments    (`limit`, `before`)

  No mesmo PR, `GET`, `PATCH` e `DELETE /v1/payment-links/{id}` passam a
  enderecar o link por organizacao E projeto, o mesmo escopo da lista: link de
  outro projeto da mesma organizacao responde 404 tambem na leitura. O
  `DELETE` documenta que os registros de pagamento do link ficam e seguem
  contando em `/v1/payment-links/stats`. So texto, com `GET /v1/payment-links`.

  Avaliacoes de politica por projeto (enterprise #1947, sobre a #1934):
  `PolicyEvaluation` ganha `projectId`, `approvalId`, `decidedAt` e
  `decidedBy`, os quatro obrigatorios e anulaveis, e `decision` passa a
  admitir `approval_required`. `GET /v1/policy-evaluations` e o alias
  `GET /v1/evaluations` documentam que chave de API e token OAuth leem so as
  avaliacoes do proprio projeto; avaliacao gravada sem projeto (o historico
  anterior a 2026-10-03 e as de nivel de organizacao) nao aparece para eles.

  `event_known` (enterprise #1873): `Trigger` e as respostas de `GET` e
  `PATCH` em `/v1/webhook-endpoints/{id}` e `/v1/triggers/{id}` ganham o
  boolean obrigatorio `event_known`. `false` quer dizer que a assinatura
  existe e nao dispara ate uma versao emitir aquele nome de evento.

  Categoria no razao (enterprise #1797): `GET /v1/account/ledger` aceita o
  filtro `category` (`compra`, `fornecedor`, `assinatura`, `recebivel`) e cada
  lancamento devolve `category`, obrigatorio e anulavel. A categoria nunca e
  inferida da descricao.

  Declaracao do tipo de conta (enterprise #1919): `GET /v1/organizations/{id}`
  devolve `account_type_declared` (boolean) e `account_type_declared_at`
  (data ou `null`), os dois obrigatorios na resposta. `account_type` so tem
  significado quando `account_type_declared` e `true`.

  Mandatos pelo dashboard (enterprise #1883): `pause`, `resume` e `revoke`, em
  `/v1/mandates/{id}` e em `/v1/consumers/mandates/{id}`, seis operacoes,
  ganham o header opcional `x-codespar-user-token` e as respostas 403 e 503.
  Os tres valem so para a autenticacao de servico; chave de API de projeto e
  token OAuth nao enviam o header.

  Recibos (enterprise #1865): em `GET /v1/consumers/{consumerId}/receipts`,
  `GET /v1/consumers/receipts/{id}` e
  `POST /v1/consumers/receipts/{id}/delivery`, `mandate.sig` deixa de ser
  obrigatorio: so vem para a credencial que ja pode gastar (`mandates:spend`
  ou `*`), e para as outras a chave fica AUSENTE, nao `null`.
  `mandate.sig_sha256` vem sempre.

  Replay de evento (enterprise #1867): o 202 de
  `POST /v1/events/{event_id}/replay` ganha `rejected` (inteiro, obrigatorio),
  os despachos que nao deixaram linha de entrega e por isso nao serao
  retentados. `dispatched + rejected` e o numero de assinaturas que casam.

  Latencia no discover (enterprise #1888): cada alternativa de
  `POST /v1/meta-tools/discover` ganha `mean_latency_ms` (obrigatorio).
  `latency_p50_ms` vira alias depreciado com o mesmo valor: sempre foi media,
  nao mediana.

  Health (enterprise #1907): `GET /v1/health` ganha `metrics`, obrigatorio,
  com `recurrence_instruction_alarms` (`status`, `open`, `kinds`). E lido,
  nunca entra na nota. `degraded` passa de quatro causas documentadas a sete.

  Codigos de erro novos em enums de resposta: `withdrawal_dispatch_uncertain`
  no 502 de `POST /v1/wallets/{id}/transfer` (enterprise #1872; o saldo segue
  retido, nao reenviar com outra chave) e `psp_refused` no 422 de
  `POST /v1/consumer-payments/execute`, `execute-stream` e
  `POST /v1/consumers/mandates/{id}/spend` (enterprise #1900; o provedor
  recusou, nada se moveu).

  So texto, alem dos ja citados. Cobrancas (enterprise #1890):
  `POST /v1/charges`, `GET /v1/charges/{chargeId}` e
  `POST /v1/charges/{chargeId}/cancel` documentam o estado `ERROR` do emissor
  e quando `status_conflict` e `true`; `POST /v1/test/charges/{chargeId}/pay`
  e o alias `POST /v1/charges/{chargeId}/sandbox/pay` documentam que so
  cobranca pagavel liquida, com `details.reason` no 409 `charge_not_payable`.
  `POST /v1/policies` (enterprise #1886): regra `budget` conta a intencao
  declarada, e um pagamento que comprovadamente nao moveu nada devolve o
  custo. `POST /v1/facilitator/x402/executions` (enterprise #1878): os tetos
  sao declarados por quem chama. Pix Automatico: a lista de eventos no campo
  `event` de `POST /v1/webhook-endpoints` e de `POST /v1/triggers` ganha
  `commerce.recurrence.cycle.announced_late` e `.instruction_missing`
  (enterprise #1885), e `.instruction_blocked`, `.instruction_refused` e
  `.queued_instruction_expired` (enterprise #1907).

## 0.16.14 — 2026-09-29

### Changed

- Snapshot do OpenAPI relido do documento servido: 293 operacoes viram 295,
  duas rotas novas e nenhuma removida. Seis operacoes mudaram de forma ou de
  texto; `components.schemas` nao muda. Snapshot `172687089376`, API 0.3.0.

  Lista e contagem de payables de um projeto (enterprise #1793), rotas novas,
  so leitura, escopo `payables:read`:

      GET /v1/payables          (filtros status, limit, before)
      GET /v1/payables/counts   (NEEDS_REVIEW, READY e o que vence nesta semana)

  `GET /v1/organizations/{id}` passa a devolver `live_approved` (boolean,
  obrigatorio na resposta): enquanto for `false`, criar projeto live responde
  403 (enterprise #1861).

  Vencimento em dia nao util (enterprise #1811): `POST /v1/payables`,
  `POST /v1/payables/documents` e `GET /v1/payables/{payableId}` documentam
  que `due_date_state` so chama um payable de `overdue` depois do vencimento
  EFETIVO (fim de semana, feriado bancario nacional e, para boleto, o ultimo
  dia util do ano rolam para o proximo dia util). Feriado estadual e municipal
  nao conta. So texto.

  Pix Automatico (enterprise #1869, desligado por padrao): a lista de eventos
  que o build emite, no campo `event` de `POST /v1/webhook-endpoints` e de
  `POST /v1/triggers`, ganha 16 eventos `commerce.recurrence.*` (pedido,
  autorizacao, negativa, cancelamento, ciclos e retencao de liquidacao). So
  texto; o campo continua string livre.

## 0.16.13 — 2026-09-29

### Changed

- Snapshot do OpenAPI relido do documento servido: 289 operacoes viram 293,
  quatro rotas novas e nenhuma removida. Nove operacoes mudaram de forma ou de
  texto; `components.schemas` nao muda. Snapshot `9d4a34e631cd`, API 0.3.0.

  Modelo de leitura da conta para o dashboard v8.1 (enterprise #1763), rotas
  novas, so leitura:

      GET /v1/account/summary
      GET /v1/account/balances
      GET /v1/account/ledger
      GET /v1/account/agent-activity

  No mesmo PR, `POST /v1/agents` e `POST /v1/orgs/{orgId}/agents` aceitam
  `role` e `runtime` e passam a recusar campo desconhecido
  (`additionalProperties: false`); `GET /v1/agents` devolve os dois. A leitura
  de `GET /v1/mandates/{id}` passa a documentar `spent_minor`,
  `period_spent_minor`, `periodic_cap`, os slots por moeda, e as listas de
  saque e de DDA.

  Tipo de conta PF/PJ (enterprise #1757): `GET /v1/organizations/{id}` devolve
  `account_type` (`PF` ou `PJ`), uma declaracao feita no cadastro, nao uma
  verificacao de documento.

  Pagamentos do consumidor (enterprise #1846, #1814, #1824): em
  `POST /v1/consumer-payments/execute`, `execute-stream`,
  `POST /v1/consumers/mandates/{id}/spend` e `POST /v1/payables/{payableId}/pay`,
  a recusa `per_tx_cap_exceeded` traz `details.amount_minor` e
  `details.per_tx_cap_minor`, e um Pix acima do teto por transacao espera uma
  pessoa (`approval_required`), com o dinheiro retido enquanto espera. So texto
  nas respostas; os codigos ja existiam.

## 0.16.12 — 2026-09-27

### Changed

- Snapshot do OpenAPI relido do documento servido: 289 operacoes seguem 289,
  nenhuma rota nova e nenhuma removida. Dez operacoes mudaram de forma ou de
  texto; `components.schemas` nao muda.

  Registro OAuth limitado (enterprise #1778): `POST /oauth/register` ganha 429
  `rate_limit_exceeded` (10 registros por hora por endereco, com
  `Retry-After`) e 503 `client_registration_cap_reached` (teto global de
  clientes registrados). O `client_name` aparece na pagina de consentimento
  marcado como nao verificado. Em `POST /oauth/token`, uma cadeia de refresh
  vive no maximo 90 dias desde o consentimento: depois disso o refresh responde
  400 `invalid_grant` e o usuario autoriza de novo (so texto; o codigo ja
  existia).

  Auditoria so pelo dashboard (enterprise #1760): reconhecer um incidente e
  alterar a configuracao de auditoria

      POST  /v1/audit-events/incidents/{id}/acknowledge
      PATCH /v1/audit-events/config
      POST  /v1/orgs/{orgId}/audit/incidents/{id}/acknowledge
      PATCH /v1/orgs/{orgId}/audit/config

  passam a ser so service auth: uma chave de API ou um token OAuth recebe 403
  `human_session_required` antes de o corpo ser lido, qualquer que seja o
  `x-codespar-user`. So texto; o 403 ja existia.

  Onboarding sob a politica da org (enterprise #1773): `POST /v1/kyc/onboard` e
  `POST /v1/account-applications` ganham 403 (`approval_required` com
  `approval_id` e `expires_at`, ou `policy_denied` com `rule_id`) e 503 (o
  motor de politica nao respondeu; recusa fail-closed, nada foi despachado,
  repetir).

  Projeto live exige aprovacao (enterprise #1772): `POST /v1/projects` com
  `environment: "live"` numa org que a CodeSpar nao aprovou para live responde
  403 `org_not_approved_for_live` (`details.org_id`) e nada e criado. A
  aprovacao e da CodeSpar, nunca por esta API. Projeto de teste nao precisa.

- A CLI nao deriva comando novo (nenhuma operacao nova). Nao muda de conteudo:
  depende de `@codespar/sdk` por faixa.

## 0.16.11 — 2026-09-27

### Changed (verdict of `verifyMandateToken`, codespar-core#123, p2-identity#6)

`@codespar/sdk/mandate` said `verified: true` about things it had not checked.
It is now strict. `verified` is true only when all of these hold:

- **Both Ed25519 signatures are carried and verify.** A token without
  `agent_sig` (only the platform signed) is not verified; neither is one without
  `issuer_sig`. A signature the token carries but no key was supplied for
  (`skipped`) no longer counts as a pass either: `verifyMandateToken(t, {
  agentPublicKey })` alone is now `verified: false` with
  `failures: ["issuer_sig_unchecked"]`.
- **The agent signature is checked under the key the token names.** The signed
  `agent_kid` names it; the unsigned envelope `kid` may not rename it
  (`kid_mismatch`). The new `agentDidDocument` option takes the agent's
  did:web document and uses only the `verificationMethod` whose `id` equals
  that kid, so a retired key listed beside the active one no longer verifies a
  token that names the active one (`kid_not_in_document` when the kid is not
  there). A raw `agentPublicKey` still works and means "this is the key for
  the token's kid"; the two options are mutually exclusive.
- **The token has not expired.** A clock past `expires_at` gives
  `expired: true` and `verified: false`. The clock is `Date.now()` unless
  `now` (UNIX seconds) is passed.

New on `MandateVerification`: `failures` (stable codes, empty exactly when
`verified` is true), `expired`, `issuedAt`.

### Added

- **V4 tokens** (`format_version: 4`, enterprise ent#657): the signing string
  inserts the signed `issued_at` before `agent_kid` (15 fields). Byte-locked
  against the enterprise `canonical.v4.fixture.json`. V3 and V2 decode and
  reconstruct as before. A `format_version` this module does not know (5+) is
  now `mandate_format_unsupported` instead of being reconstructed with the V3
  tail and failing as if tampered.

### Not changed

- The API mints V3 today, and every Ed25519-signed token it mints carries both
  signatures (enterprise `dualSignMandateV3`, the only mint site), so the
  strict verdict refuses no token the API issues inside its window. V2 tokens
  carry no Ed25519 signature and were already never verified offline.
- "Was this key active when it signed" (D3) is still not checkable offline:
  the did:web document publishes retired keys without their retirement time.

## 0.16.10 — 2026-09-27

### Changed

- Snapshot do OpenAPI relido do documento servido: 289 operacoes seguem 289,
  nenhuma rota nova e nenhuma removida. Vinte e cinco operacoes mudaram de
  forma ou de texto; `components.schemas` ganha `SpendApproval` e
  `SpendQuote.at` passa a ser `format: date-time`.

  Hash de aprovacao selado no recibo (ent#1670, enterprise #1698): o corpo de

      POST /v1/consumers/mandates/{id}/spend
      POST /v1/consumer-payments/execute
      POST /v1/consumer-payments/execute-stream

  ganha `approval` opcional (`SpendApproval`: `items_hash` obrigatorio,
  `batch_hash` opcional, SHA-256 em hex minusculo com prefixo `sha256:`
  opcional). E uma AFIRMACAO SELADA de quem chama, nao uma checagem de
  aprovacao: o servidor so valida a forma e sela o valor como elo proprio da
  cadeia (versao 4). O 400 dessas rotas ganha `invalid_approval_hash` e
  `invalid_receipt_timestamp` (`quote.at` fora de RFC 3339 com offset). Um
  `approval` diferente sob o mesmo `attempt_id` e `attempt_id_conflict`.

  As leituras de recibo

      GET  /v1/consumers/{consumerId}/receipts
      GET  /v1/consumers/receipts/{id}
      POST /v1/consumers/receipts/{id}/delivery

  ganham `chain_version` (obrigatorio: 1 a 4), `approval` (so quando o gasto
  levou um) e `mandate.sig_sha256` (obrigatorio: o que a cadeia v4 sela no
  lugar de `mandate.sig`, para um terceiro recalcular sem ver a assinatura).
  `chain` ganha a receita completa dos elos. O `at` do corpo de `delivery`
  passa a exigir RFC 3339 com offset (`invalid_receipt_timestamp`).

  `attempt_id` obrigatorio sob flag (ent#1671, enterprise #1743): o 400 das
  tres rotas de gasto ganha `attempt_id_required`, respondido quando a
  implantacao liga `ATTEMPT_ID_REQUIRED_ENFORCE` e o corpo nao nomeia
  `attempt_id`. O schema nao muda: `attempt_id` segue opcional no tipo.

  Aprovacoes por projeto (enterprise #1751, #1754), em `/v1/approvals` e nos
  aliases `/v1/orgs/{orgId}/approvals`: uma chave de API ou um token OAuth le
  so as retencoes do PROPRIO projeto e nunca recebe `tool_input`, que deixa de
  ser obrigatorio nas quatro leituras e no 200/409/410 de `decide`. Decidir
  passa a ser so do dashboard (service auth): chave ou token OAuth recebe
  `bearer_token_cannot_decide` mesmo com user token. So texto em
  `POST /v1/orgs/{orgId}/pause` e `POST /v1/payables/{payableId}/review`.

  Open Finance em projeto live (enterprise #1717), em `/v1/bank-consents` e
  no alias `/v1/ofb/consents`: criar, `callback` e `refresh-statement` ganham
  422 `ofb_not_live` e 503 `ofb_adapter_unavailable`.

  Credencial de sandbox compartilhada fora de projeto de teste (enterprise
  #1739): `POST /v1/providers/{slug}/verify-connection` ganha
  `shared_sandbox_live_project_refused` em toda resposta de erro, e o 424 de
  `POST /v1/sessions/{id}/proxy_execute` vira uniao com esse codigo.

  `POST /v1/account-applications` (enterprise #1714): so texto. Onboarding de
  pessoa fisica em projeto live sem `buyer.financialDetails` e recusado com
  400.

- A CLI nao deriva comando novo (nenhuma operacao nova). Nao muda de conteudo:
  depende de `@codespar/sdk` por faixa.

## 0.16.9 — 2026-09-26

### Changed

- Snapshot do OpenAPI relido do documento servido: 289 operacoes seguem 289,
  nenhuma rota nova e nenhuma removida. Quinze operacoes mudaram de forma ou de
  texto, e `components.schemas.SpendOutcome` ganha dois campos.

  Replay de tentativa liquidada (ent#1671, enterprise #1683): apresentar o
  `attempt_id` de uma tentativa ja liquidada, com o mesmo valor, recebedor,
  mandato, trilho e cotacao, devolve o 200 ORIGINAL, verbatim, sem despachar
  nada. Afeta:

      POST /v1/consumers/mandates/{id}/spend
      POST /v1/consumer-payments/execute
      POST /v1/consumer-payments/execute-stream   (so texto)

  `SpendOutcome` ganha `attempt_id` e `idempotent_replay`, os dois
  obrigatorios. O 409 das duas primeiras ganha `attempt_id_conflict` (mesmo
  `attempt_id`, pagamento diferente; `mismatched_fields` diz o que difere) e
  `attempt_id_unavailable` (outro projeto da organizacao ja tem esse
  `attempt_id`). `psp_attempt_in_flight` passa a mandar repetir o MESMO
  `attempt_id` quando a primeira chamada responder. Sem `attempt_id` nao ha
  idempotencia: duas chamadas sao dois pagamentos.

  Conexao OAuth vencida (enterprise #1691): `POST
  /v1/providers/{slug}/verify-connection` ganha o codigo `connection_expired`
  (424, com `expires_at`); `status` das rotas de `/v1/connections` ganha
  descricao dizendo que `expired` inclui o token OAuth vencido.

  Consentimento Open Finance (enterprise #1685), em `/v1/bank-consents` e no
  alias `/v1/ofb/consents`: o 409 de `callback` ganha `consent_expired`
  (terminal) e o 409 de `refresh-statement` ganha `consent_expired` (terminal)
  e `consent_token_expired` (nao terminal: o consentimento segue `authorised`).

  `POST /v1/sessions` (enterprise #1688, #1694): corpo ganha `agent_id`
  opcional, o agente registrado que a sessao representa; o texto de `servers`
  passa a dizer 0–20 (o schema ja nao tinha minimo).

  `POST /v1/agents/{did}/revoke` (enterprise #1655, #1657): so texto. Revogar
  passa a impedir gasto sob mandatos do consumidor vinculados a chave do
  agente, cartao incluido.

- A CLI nao deriva comando novo (nenhuma operacao nova). Nao muda de conteudo:
  depende de `@codespar/sdk` por faixa.

## 0.16.8 — 2026-09-25

### Changed

- Snapshot do OpenAPI relido do documento servido: 287 -> 289 operacoes, duas
  rotas novas e nenhuma removida. Seis operacoes mudaram de forma ou de texto;
  `components` nao muda.

  Kill switch da organizacao (ent#1648, enterprise #1652 + #1653):

      GET  /v1/orgs/{orgId}/pause   estado do kill switch (`paused`, `reason`,
                                    `paused_by`, `paused_by_source`,
                                    `generation`); escopo `projects:read`
      POST /v1/orgs/{orgId}/pause   pausa todo gasto de agente da organizacao;
                                    escopo novo `organizations:pause`.
                                    Idempotente (`changed: false`). Retomar
                                    nao e operacao de chave de API

  Enquanto pausada, toda porta de dinheiro de agente responde 403
  `org_paused`. `GET /v1/mandates/{id}` ganha `org_paused` e `org_paused_at`
  (obrigatorios) e `GET /v1/organizations/{id}` ganha `spend_pause`
  (obrigatorio, anulavel). `POST /v1/webhook-endpoints` e `POST /v1/triggers`
  passam a listar `commerce.organization.paused` e
  `commerce.organization.resumed` entre os eventos emitidos.

  `GET /v1/health` (enterprise #1582): `checks.fx_rates.status` troca `fresh`
  por `usable` (`usable` | `stale` | `missing`), derivado de `hours_old`, e
  `last_fetched_at` passa a ser o carimbo de mercado do fechamento PTAX mais
  novo, nao a hora em que o fetcher rodou. Quem compara com `"fresh"` deixa de
  casar.

  `POST /v1/orgs/{orgId}/mandates` (enterprise #1649): so texto. O 501 passa a
  dizer que trata de oferecer a emissao, nao de aplicar o teto.

- A CLI nao deriva comando novo (97 derivados seguem 97): as duas rotas novas
  caem em `orgs`, grupo sem comando derivado. Nao muda de conteudo: depende de
  `@codespar/sdk` por faixa.

## 0.16.7 — 2026-09-24

### Changed

- Snapshot do OpenAPI relido do documento servido: 285 -> 287 operacoes, duas
  rotas novas e nenhuma removida. Nove operacoes mudaram de forma ou de texto,
  e `components.schemas` ganha `PaymentActor`.

  Rotas novas:

      GET  /.well-known/codespar-receipt-keys.json   JWKS publico das chaves
                                                     Ed25519 que selam recibos
      POST /v1/audit-events/verify                   veredito da cadeia num
                                                     intervalo (`verified` |
                                                     `broken` | `unverified`)

  Recibos agenticos (`GET /v1/consumers/{consumerId}/receipts`,
  `GET /v1/consumers/receipts/{id}`, `POST /v1/consumers/receipts/{id}/delivery`)
  ganham `actor`, `receipt_sig_ed25519` e `receipt_sig_kid`, os tres
  obrigatorios (anulaveis) na resposta.

  Kids com namespace de ambiente (enterprise #1643, ent#1641): o documento de
  chaves ganha `key_namespace` (obrigatorio) e todo kid documentado passa de
  `<did>#<n>` para `<did>#<namespace>-<n>` — recibos (`receipt_sig_kid`),
  registro de agente (`POST /v1/agents`, `POST /v1/orgs/{orgId}/agents`) e o
  `{kid}` das duas rotas de revogacao. Um kid ausente do documento buscado
  significa recibo de outro ambiente (`unknown_key`), nao recibo adulterado.

  Quem disparou o gasto (`PaymentActor`, opcional: `agent` com `on_behalf_of`
  ou `human` com `channel`):

      POST /v1/consumers/mandates/{id}/spend       `actor` no corpo; novo 400
      POST /v1/consumer-payments/execute           `actor_consumer_mismatch`
      POST /v1/consumer-payments/execute-stream

  `POST /v1/consents/{token}/submit`: `attestation.evidence` (canal, ids da
  mensagem/sessao, ip, user agent, geo, contato); novo 400
  `attestation_evidence_invalid` e novo 409 `contact_verification_required`.

  `POST /v1/webhook-endpoints` e `POST /v1/triggers`: `event` passa a
  documentar o casamento exato (sem prefixo, sem curinga) e a lista de eventos
  que este build emite.

- Cada operacao declara o escopo de chave que exige (enterprise #1642): 273
  ganham `security: [{ bearerAuth: ["<escopo>"] }]` e 274 ganham
  `x-codespar-scope` (`GET /v1/whoami` declara `"none"` e herda o `security`
  global). As 13 rotas publicas (`/.well-known/*`, `/oauth/*`, os documentos
  `openapi.json`/`meta-tools.json` e as duas rotas de consentimento por token)
  declaram `security: []` e nenhum escopo. Isso nao muda os tipos gerados:
  `src/generated/openapi.ts` nao representa `security`.

- A CLI nao deriva comando novo (97 derivados seguem 97): as duas rotas novas
  caem em grupos sem comando derivado (`audit-events`, `.well-known`). Nao muda
  de conteudo: depende de `@codespar/sdk` por faixa.

## 0.16.6 — 2026-09-23

### Changed

- Snapshot do OpenAPI relido do documento servido: 285 operacoes, nenhuma
  rota nova e nenhuma removida. Dez operacoes mudaram de forma ou de texto.

  Familia `charges` (enterprise #1623):

      POST /v1/charges                          `consumer_id` no corpo (opcional;
                                                REQUIRED para `boleto`, recusa
                                                `consumer_id_required`); `amount`
                                                documentado em unidades MAIORES
                                                (`12.5` = R$ 12,50), nao centavos
      GET  /v1/charges/{chargeId}               a referencia aceita id da cobranca,
                                                transaction id do emissor ou
                                                `idempotency_key`; novo 409
                                                `charge_reference_ambiguous`
      POST /v1/charges/{chargeId}/cancel        mesmo 409 novo
      POST /v1/test/charges/{chargeId}/pay      o pagamento no sandbox vira
      POST /v1/charges/{chargeId}/sandbox/pay   `status: CONFIRMED` (documentado)

  Familia `cards`: `GET/POST /v1/cards`, `GET /v1/cards/{id}`,
  `GET/POST /v1/issuer/cards` ganham o campo `cde`
  (`ingested | not_ingested | not_configured`) na resposta.

- A CLI nao deriva comando novo (97 derivados seguem 97) e nao muda de
  conteudo: depende de `@codespar/sdk` por faixa.

## 0.16.5 — 2026-09-23

### Changed

- Snapshot do OpenAPI relido do documento servido: 283 -> 285 operacoes, duas
  rotas novas e nenhuma removida.

      POST /v1/test/charges/{chargeId}/pay              (nova)
      POST /v1/charges/{chargeId}/sandbox/pay           (deprecated no documento)

  A rota de pagar uma cobranca no sandbox ganhou o caminho canonico sob
  `/v1/test/`, ao lado de `fund`, `pix-in` e `settle-pix-in`; a antiga sob
  `/v1/charges/` segue servida e vem marcada `deprecated`, e o comando derivado
  dela (`charges sandbox-pay`) se anuncia assim no `--help`.

- A CLI deriva dois comandos novos da mesma tabela (`test charges-pay`,
  `charges sandbox-pay`), 95 -> 97 derivados. Ela nao muda de conteudo: depende
  de `@codespar/sdk` por faixa (`^0.16.1`).

## 0.16.4 — 2026-09-23

### Changed

- Snapshot do OpenAPI relido do documento servido: 280 -> 283 operacoes, tres
  rotas novas e nenhuma removida.

      POST /v1/payables/documents
      POST /v1/payables/{payableId}/review
      POST /v1/payables/{payableId}/pay

  A porta de documento do payable passou a ser rota PROPRIA. Antes ela era o
  mesmo `POST /v1/payables` com corpo `multipart/form-data`, e uma operacao com
  dois content types trava o gerador deste pacote, que manda exatamente um: o
  `spec:refresh` reprovava com "operation declares 2 request content types", e
  com isso o snapshot ficou sem poder ser regenerado e o `spec-freshness` ficou
  vermelho na main para todo mundo. Com a rota separada o gerador aceita a
  multipart sozinha, e `operations.ts` a traz com `body: "multipart/form-data"`.

- A CLI deriva tres comandos novos do mesmo table (`payables documents`,
  `payables review`, `payables pay`), 92 -> 95 derivados. Ela nao muda de
  conteudo: depende de `@codespar/sdk` por faixa (`^0.16.1`), entao uma
  instalacao nova ja os traz.

## 0.16.3 — 2026-09-23

### Changed

- `fakeSession` passa a devolver `userId`, `servers` e `createdAt`, que
  `@codespar/types@0.11.2` agora exige de um `Session`. Os defaults sao
  `"user_fake"`, `[]` e uma data FIXA (`2026-01-01`), nao `new Date()`: mock com
  relogio faz teste que passa hoje e reprova amanha. As tres viraram opcoes de
  `fakeSession(responses, options)`.

## 0.16.2 — 2026-09-21

### Changed

- Snapshot do OpenAPI relido do documento servido (232 rotas, 280 operacoes,
  as mesmas). Duas mudancas de forma entraram: `POST /v1/sessions` deixou de
  exigir `servers` com pelo menos um elemento, porque uma sessao que so roda
  meta-tool nao tem servidor a anexar (ent#1566), e o corpo de mandato ganhou
  `periodic_cap` com `window` (`day` | `month`) e `cap_minor`, que ja estava no
  servido e faltava aqui.
- `attestation.method`, em `POST /v1/consents/{token}/submit`, ganhou um quarto
  valor: `partner_biometric`. A uniao gerada passa a ser
  `"partner_session" | "in_person" | "verified_code" | "partner_biometric"`.
  Subiu na API entre as 22:13 e as 00:26 de 21/09 e o portao de frescor pegou
  na mesma noite.

## 0.16.1 — 2026-09-21

### Added

- `API_OPERATIONS` rows carry `deprecated`, and `ApiOperationRef` declares it.
  The document marks an operation as dead and nothing downstream could read
  that mark: the CLI derived 22 commands onto buried routes without knowing.
  55 of the 280 rows are `deprecated: true`.
- Four operations the document gained since the last refresh:
  `GET /v1/consents/{token}`, `POST /v1/consents/{token}/submit`,
  `POST /v1/payables` and `GET /v1/payables/{payableId}`. The typed client
  reaches 280.

### Changed

- The OpenAPI snapshot is re-fetched from the served document
  (276 → 280 operations). The two consumer-spend endpoints now
  answer 422 with `carrier_crc_invalid`, `carrier_malformed` or
  `carrier_format_unsupported` when the payee is a Pix copia-e-cola that
  fails its own check (codespar-enterprise#1427), and the generated types
  carry those codes.

## 0.15.0 — 2026-09-14

### Changed

- Re-exports the `@codespar/types` 0.11.0 contract, in which a meta-tool
  input property may publish `anyOf` instead of a single `type`
  (codespar-core#128). Consumers reading `property.type` as a `string`
  must handle `undefined` for a union property.

## 0.14.0 — 2026-09-14

### Added

- The OpenAPI snapshot goes from 221 to 227 operations, so `cs.api` and
  `API_OPERATIONS` reach six routes the served document had been missing:
  the `/v1/charges` family (list, issue, read, withdraw) and the
  meta-tool catalogue document under both mounts (`/meta-tools.json` and
  `/v1/meta-tools.json`). No operation was removed.

## 0.12.0

A REST client generated from the served OpenAPI document lands next to the session API. Closes the "SDK covers 11 of 213 routes" half of [codespar/codespar-core#125](https://github.com/codespar/codespar-core/issues/125).

### Added

- `cs.api`: a client typed by path and method over every operation of `https://api.codespar.dev/openapi.json` (215 operations across 175 paths at the snapshot this version ships). `cs.api.get("/v1/wallets/{id}", { path: { id } })`, `cs.api.post("/v1/wallets", { body })`, plus `put`/`patch`/`delete`, `request(method, path, options)` and `response(method, path, options)`. Path, query and header parameters and the request body are typed from the document and required exactly where the document requires them; the return type is the documented 2xx shape. `response()` returns every documented status as `{ status, ok, data, response }` for routes where a 402/403/422 body is an outcome, not a failure. Non-2xx statuses from `request()` throw the existing `CodesparApiError` with the parsed body on `e.body`; network failures, timeouts and aborts behave as they do on `Session`.
- `createApiClient(config)` and `ApiClient` for callers who want the REST client without a `CodeSpar` instance; `API_OPERATIONS` (the generated operation table) and `ApiClient.operations()` to enumerate what the client reaches; `ApiPaths`, `ApiComponents`, `ApiOperation`, `ApiRequestOptions`, `ApiResponse`, `ApiSuccess` and friends for typing wrappers.
- `packages/core/openapi-snapshot.json`: the served document with its sha256, fetch time and source URL. `src/generated/openapi.ts` (openapi-typescript) and `src/generated/operations.ts` are generated from it and committed. `npm run sdk:spec:refresh` re-fetches and regenerates; `npm run sdk:spec:check` exits non-zero when the snapshot was edited by hand, when the generated files do not match the snapshot, or when the served document no longer matches the snapshot. The vitest suite pins the hermetic half and dispatches every operation of the table through the client (213 of 213).

### Changed

- The package now carries the generated declaration file for the whole document (about 1.1 MB of `.d.ts`); no runtime code was added beyond the thin client and the 213-row table. No runtime dependency was added: `openapi-typescript` is a devDependency used only by the generator.
- Includes the changes that landed on `main` after the 0.11.0 tag and were waived in `scripts/publish-drift-baseline.json` (core#131): request timeout and cancellation (#49) and #120. Their entries are in the sections above where they were written; this bump is the release decision the waiver was waiting for.

## 0.11.0

Offline V3 mandate verification lands on the SDK as a dedicated subpath. See [codespar/codespar-core#114](https://github.com/codespar/codespar-core/pull/114).

### Added

- `@codespar/sdk/mandate` subpath export: `verifyMandateToken(token, { agentPublicKey, issuerPublicKey })`, `decodeMandateToken`, `reconstructSigningString`, and `verifyEd25519`. Verifies the V3 dual Ed25519 signatures (agent + platform issuer) with `node:crypto` only — no API call, no credential. Lives on a subpath (like `./testing`) so `node:crypto` stays out of the edge-safe main graph; the zero-runtime-dependency rule holds (`node:crypto` is a builtin).
- The canonical signing string is byte-locked against the platform's frozen fixture in tests; the same fixture guards the CLI and Python implementations, so any codec drift fails all of them loudly.

## 0.10.0

The hosted test-mode SDK surface lands across `@codespar/sdk`, `@codespar/types`, and the `codespar` Python package. See [codespar/codespar-core#54](https://github.com/codespar/codespar-core/pull/54).

### Added

- `cs.create(userId, { mocks: {...} })`. Keys are canonical tool names in slash form (`asaas/create_payment`); values are a `MockObject` for a static mock or a `MockObject[]` for a stateful mock consumed in order. Forwarded verbatim on `POST /v1/sessions` — the SDK does not rewrite tool names, so the double-underscore form (`asaas__create_payment`) surfaces as `mocks_invalid` rather than being silently rewritten. Absent case stays wire-neutral (no `mocks` key on the body).
- `MockObject` and `MockValue` type aliases re-exported from `@codespar/types`. `SessionConfig` widens to accept the optional `mocks` field.
- `CodesparApiError` — structured exception class shared by every transport-failure throw site in `session.ts`. Constructor signature `new CodesparApiError(message, { status, code?, body?, cause? })`. Network errors that never reach the backend surface as `status: 0` with the underlying `fetch` rejection preserved as `cause`.
- `tool-result-codes` module (`packages/core/src/tool-result-codes.ts`). Five variants — `PolicyDenied`, `ApprovalRequired`, `MocksExhausted`, `MocksEngineError`, `ToolNotMocked` — plus matching `*Output` interfaces, narrowed `*ToolCall` aliases, the `ToolResultCode` union, the `TOOL_RESULT_CODES` set, five predicate guards (`isPolicyDenied`, `isApprovalRequired`, `isMocksExhausted`, `isMocksEngineError`, `isToolNotMocked`), and the `assertExhaustiveToolResult` helper that makes a `switch` over `ToolResultCode` fail to compile when a sixth variant lands without a handler. Each guard checks the `code` discriminant AND its required sibling fields, so a payload with a well-formed `code` but a missing `rule_id` / `approval_id` / `tool_name` returns false rather than narrowing positive.
- `CODESPAR_BASE_URL` environment variable resolved at client construction. Cascade: explicit `baseUrl` option, then `CODESPAR_BASE_URL`, then `https://api.codespar.dev`. Point the same client wiring at a [local OSS runtime](https://github.com/codespar/codespar) without rebuilding call sites.
- Bumped `@codespar/types` dependency range to `^0.10.0`.

### Changed

- **SemVer-minor break for callers parsing `e.message` strings.** The generic `throw new Error("send failed: 500 ...")` shape is gone — every transport call site (`createSession`, `proxyExecute`, `send`, `sendStream`, `paymentStatus(Stream)`, `verificationStatus(Stream)`, `authorize`) now throws `CodesparApiError`. Migration recipe: `e.message.includes("foo")` becomes `e.code === "foo"`.
- `session.execute(...)` keeps its existing returns-vs-throws asymmetry — non-ok responses still come back as `ToolResult.success === false` with the body in `error`. Only transport exceptions change shape.

## 0.9.0

- New: `session.paymentStatusStream(toolCallId, { onUpdate?, signal? })`.
  Opens a Server-Sent Events stream against
  `GET /v1/tool-calls/:id/payment-status/stream`, invokes `onUpdate`
  for the initial snapshot + every state change, and resolves with
  the last envelope observed (the backend pushes a final `done` frame
  5s after a terminal state). `AbortSignal` cancels.
- New: `session.verificationStatusStream(toolCallId, { onUpdate?, signal? })`
  — KYC sibling with the same lifecycle. Auto-closes 5s after a
  terminal disposition (approved / rejected / expired).
- The polling siblings (`paymentStatus` / `verificationStatus`) stay
  live for backward compat. Pick whichever fits the call site —
  streaming is preferred for long-running pending → settled flows;
  polling is fine for one-off "is this done yet?" reads.
- Heartbeat comment frames (`: heartbeat <ts>`) are filtered by the
  SSE parser; surface to dev tools only.
- Internal: introduced `parseStatusSseStream` helper distinct from
  the chat-loop `parseSseStream` since the status streams emit named
  events (`snapshot` / `update` / `done`) rather than the
  discriminated-union `StreamEvent` payload the chat loop ships.
- Bumped peer dep `@codespar/types` minimum to 0.7.0.

## 0.8.0

Previous release. See git log for prior entries.
