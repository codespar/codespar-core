# @codespar/types — CHANGELOG

## 0.12.0 — unreleased (coordinated codespar_card release)

### Breaking

- **`codespar_card` replaces `codespar_issue`, with no alias.**
  - The old definition (`ISSUE_DEFINITION`) is removed, and `SHARED_META_TOOL_DEFINITIONS` lists `codespar_card` in its place. `SharedMetaToolName` follows.
  - `Session.issue()`, `IssueArgs` and `IssueResult` are removed. `Session` implementers must provide `card()`.

| Before | Now |
|---|---|
| `session.issue({ action: "card-virtual", cardholder_id, program_id })` | `session.card({ action: "issue", currency, mandate_id, consumer_id, idempotency_key, provider? })` |
| `session.issue({ action: "card-get", card_id })` | `session.card({ action: "get", card_id })` |
| `session.issue({ action: "card-control", card_id, control: "freeze" })` | `session.card({ action: "freeze", card_id, reason? })` (and `unfreeze`, `cancel`) |
| `IssueArgs` / `IssueResult` | `CardArgs` / `CardResult` |
| `codespar_issue` (meta-tool) | `codespar_card` |

### Added

- `CARD_DEFINITION` / `CARD_INPUT`: one card contract for BRL on Pomelo (`pomelo_brl`) and USD on Rain (`rain_usd`).
  - Actions: `issue | get | list | freeze | unfreeze | cancel`.
  - Properties: `currency` (BRL | USD), `provider` (pomelo | rain), `mandate_id`, `consumer_id`, `idempotency_key`, `holder` (Pomelo cardholder identity, pomelo_brl only), `card_id`, `issuer` (pomelo | rain), `reason` (client_request | lost | stolen | broken | upgrade).
  - `required` is `["action"]`. The server enforces `idempotency_key`, currency, mandate and holder on `issue`.
- `Session.card(args: CardArgs): Promise<CardResult>`.
  - `CardArgs` is `CardIssueArgs | CardGetArgs | CardListArgs | CardControlArgs`.
  - `CardResult` narrows on `state`:
    - `issued`: the card view nested in `card`, plus `authorization_id` / `authorization_active`;
    - `pending_human`: a `pending_action` for `holder`, `company_signatory` or `org_admin`;
    - `processing` / `uncertain`: `retry_after_seconds`, plus `note` and `issuer_code` on uncertain;
    - `refused`.
  - A definitive issuer failure is a refusal, never a state. A result with no `state` is a card view or a list.
- `CardReadiness` / `CardProgramReadiness` / `CardRequirement`, for `GET /v1/cards/readiness`.
- The scenario manifest moves to 0.12.0.

## 0.11.7 — 2026-10-30

### Added

- `Session.research?` with `AgentResearchInput`, `AgentResearch` and
  `AgentResearchOffer` (Shop v0.3 research, `/v1/shop/agent/research`).
- `AgentPurchaseInput` is a union: `{ merchant, items }` or `{ offerId, quantity? }`.

## 0.11.6 — 2026-10-30

### Changed

- `Session.instruments.list(opts?)`: `owner` is optional and deprecated (Shop
  v0.3, enterprise #2239). The list is the authenticated person's own; a
  credential with no person gets 403 `bearer_token_has_no_person`.

## 0.11.5 — 2026-10-23

### Added

- `Session.purchases?` and `Session.instruments?` (Shop v0.2 delegated
  purchases, `/v1/shop/agent/*`), optional so a runtime without the Shop
  omits them, and the wire types `AgentPurchaseInput`, `AgentPurchase`,
  `AgentPurchaseCreated` and `AgentInstrument`. An assistant proposes and
  reads; paying stays the person's act on the dashboard.

## 0.11.4 — 2026-09-26

### Added

- `codespar_pay` publishes `idempotency_key` (optional string), and
  `PayArgs` declares it. The managed runtime now refuses a boleto pay
  without one (`boleto_idempotency_key_required`,
  [codespar/codespar-enterprise#1752](https://github.com/codespar/codespar-enterprise/pull/1752)),
  and `codespar pay --arg` only accepts property names this definition
  publishes: until now a CLI caller could send the key through `--input`
  and not through `--arg`. Reusing the key returns the first result
  instead of paying twice; a new key is a new payment. It stays optional
  in the schema because only `method=boleto` requires it, and the flat
  schema cannot say that.

## 0.11.3 — 2026-09-23

### Changed

- `runContractSuite` pins the `POST /v1/sessions` 201 body on every leg:
  status `201`, `id`, `status: "active"`, the posted `user_id`, `servers`
  as a `string[]` containing every posted id, and a parseable `created_at`
  — the fields `@codespar/sdk` builds its session from. The `connections`
  leg asserts `{ servers }` with `id` + `connected` on each entry (`tools`,
  when present, must be an array) and fails on a non-2xx instead of
  reporting `[]`. A runtime that returns less than the SDK reads now fails
  the suite. `runMetaToolConformanceSuite` opens its session under the
  same 201 assertion. A session whose 201 body is rejected is DELETEd
  before the failure propagates, so a non-conforming runtime is not left
  with one open session per leg per run.
- `assertCreatedSessionShape`, `assertConnectionsShape` and
  `postSessionChecked` are exported from `@codespar/types/testing` so a
  runtime's own tests can reuse them.

## 0.11.2 — 2026-09-23

### Changed

- `Session` passa a declarar `userId`, `servers` e `createdAt`. Os tres sao
  escritos sem condicao pelo `createSession` do SDK desde sempre; o tipo e que
  nao os tinha, entao `session.servers` reprovava no `tsc` e o editor nao
  completava. `tools()` e `findTools()` continuam FORA de proposito: sao
  internas, e as funcoes livres `tools(session)` / `findTools(session)` sao a
  API publica.

## 0.11.1 — 2026-09-19

### Fixed

- `SHOP_STATUS_READY_FIXTURE.pix_copia_e_cola` é um BR Code que um leitor
  aceita. O valor anterior declarava 36 caracteres para uma chave de 11 e
  fechava com `6304ABCD` no lugar do CRC, então a API o recusa desde a
  codespar-enterprise#1427 (`carrier_crc_invalid`), e um leitor tolerante
  extraía dele uma chave que não é de ninguém.

## 0.11.0 — 2026-09-14

### Changed

- **A property may publish a union of shapes.** `MetaToolInputProperty`
  gains `anyOf`, and `type` becomes optional — exactly one of the two is
  present. `codespar_pay.recipient` is why: it takes either a Pix key
  string or a bank-account object, and it was published as
  `type: "string"` with a description telling the caller to pass an
  object anyway. A client that enforces the declared schema — strict MCP
  validation, OpenAI strict tool mode, a gateway running ajv — rejected
  the correct call before it left the machine. See
  [codespar/codespar-core#128](https://github.com/codespar/codespar-core/issues/128).
- `recipient` now declares both branches, and the bank-account branch
  declares `bank`, `account`, `branch`, `tax_id`, `name` and
  `account_type` field by field, where the prose used to list them.
- The conformance machinery reads unions: the prose walk and the
  vocabulary walk descend into branches, and the cross-runtime comparator
  compares shape signatures — so a runtime that flattens the union back to
  one type, or drops a field from a branch, is reported. Branch order is
  not part of the signature: a union is a set.

## 0.10.0

- Added `MockObject` and `MockValue` type aliases for the hosted
  test-mode surface. `MockObject` is a `Record<string, unknown>`
  representing a single mock response payload; `MockValue` is a
  `MockObject | MockObject[]` union — a single object is a static
  mock (same response every call), an array is a stateful mock
  consumed in order with `mocks_exhausted` once the list is drained.
- Widened `CreateSessionRequest` with an optional
  `mocks?: Record<string, MockValue>` field. Keys are canonical tool
  names in slash form (`asaas/create_payment`); the SDK forwards them
  verbatim so the OSS double-underscore form
  (`asaas__create_payment`) surfaces as `mocks_invalid` from the
  backend rather than being silently rewritten.
- Note: 0.8.0 and 0.9.0 were not released; this jump aligns
  `@codespar/types` with the `@codespar/sdk` and `codespar` Python
  package versions.

## 0.7.0

- Added `Session.paymentStatusStream` and `Session.verificationStatusStream`
  signatures alongside the existing polling siblings. Both methods take
  an options object with optional `onUpdate` callback + `AbortSignal`,
  and resolve with the last envelope observed (typically the terminal
  state pushed by the backend before it closes the SSE stream).
- Added `PaymentStatusStreamOptions` and `VerificationStatusStreamOptions`
  type exports to support the new signatures.
- Polling endpoints (`paymentStatus` / `verificationStatus`) remain in
  the contract — additive change only.

## 0.6.0

Previous release. See git log for prior entries.
