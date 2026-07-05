# @codespar/sdk — CHANGELOG

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
