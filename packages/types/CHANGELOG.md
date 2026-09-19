# @codespar/types — CHANGELOG

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
