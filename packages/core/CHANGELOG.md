# @codespar/sdk — CHANGELOG

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
