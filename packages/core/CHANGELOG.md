# @codespar/sdk — CHANGELOG

## Unreleased

- New: `CodesparApiError` — structured exception class shared by every
  transport-failure throw site in `session.ts`. Constructor signature
  `new CodesparApiError(message, { status, code?, body?, cause? })`.
  Network errors that never reach the backend surface as `status: 0`
  with the underlying `fetch` rejection preserved as `cause`.
- **SemVer-minor break for callers parsing `e.message` strings.** The
  generic `throw new Error("send failed: 500 ...")` shape is gone —
  every transport call site (`createSession`, `proxyExecute`, `send`,
  `sendStream`, `paymentStatus(Stream)`, `verificationStatus(Stream)`,
  `authorize`) now throws `CodesparApiError`. Migration recipe:
  `e.message.includes("foo")` becomes `e.code === "foo"`.
- `session.execute(...)` keeps its existing returns-vs-throws asymmetry
  — non-ok responses still come back as `ToolResult.success === false`
  with the body in `error`. Only transport exceptions change shape.
- On Python: `_http.py` honors `code` over `error` when both are
  present on a non-success response body. New hosted-test-mode
  envelopes (`mocks_not_authorized`, `mocks_invalid`, etc.) carry
  `code`; pre-PRD responses that only set `error` remain compatible.
- New: `MockObject` + `MockValue` type aliases in `@codespar/types`
  and the Python package. `SessionConfig` widens to accept the
  optional `mocks` field on `cs.create({ mocks: {...} })`.

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
