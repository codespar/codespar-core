# codespar (Python SDK) — CHANGELOG

## 0.9.0

- New: `AsyncSession.payment_status_stream(tool_call_id, *, on_update=None)`.
  Opens an SSE stream against
  `GET /v1/tool-calls/:id/payment-status/stream`, invokes `on_update`
  (sync or async callable) for the initial snapshot + every state
  change, and returns the last envelope observed once the backend
  closes the stream (5s after terminal state). Cancel by wrapping
  the awaitable in an `asyncio.Task` and calling `.cancel()`.
- New: `AsyncSession.verification_status_stream(tool_call_id, *, on_update=None)`
  — KYC sibling with the same lifecycle.
- New: matching sync wrappers `Session.payment_status_stream` and
  `Session.verification_status_stream` on the blocking client.
- New: `_http.stream_sse_get(...)` helper, GET-based SSE iterator
  yielding `(event_name, payload)` tuples and filtering heartbeat
  comment frames. The existing `stream_sse` (POST-based) is kept for
  the chat-loop's `send_stream`.
- Polling siblings (`payment_status` / `verification_status`) stay
  live for backward compat.
- User-Agent bumped to `codespar-python/0.9.0`.

## 0.8.0

Previous release. See git log for prior entries.
