# @codespar/sdk — CHANGELOG

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
