# @codespar/types — CHANGELOG

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
