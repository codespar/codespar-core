# @codespar/types — CHANGELOG

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
