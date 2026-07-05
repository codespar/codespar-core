# codespar (Python SDK) — CHANGELOG

## 0.11.0

Offline V3 mandate verification lands as the `codespar.mandate`
submodule, in parity with `@codespar/sdk/mandate` and the CLI. See
[codespar/codespar-core#114](https://github.com/codespar/codespar-core/pull/114).

### Added

- `codespar.mandate`: `decode_mandate_token` and
  `reconstruct_signing_string` are pure stdlib; `verify_ed25519` and
  `verify_mandate_token` verify the V3 dual Ed25519 signatures and
  lazily import `cryptography`, raising a clear install hint when it is
  absent. New optional extra: `pip install codespar[verify]`. The base
  package keeps its single runtime dependency (httpx).
- The canonical signing string is byte-locked against the platform's
  frozen fixture, shared with the TS SDK and CLI tests.

## 0.10.0

The hosted test-mode SDK surface lands across the `codespar` Python
package alongside `@codespar/sdk` and `@codespar/types`. See
[codespar/codespar-core#54](https://github.com/codespar/codespar-core/pull/54).

### Added

- `cs.create("user", mocks={...})` — optional mocks map forwarded
  verbatim on `POST /v1/sessions`. Keys are canonical tool names in
  slash form (`asaas/create_payment`); values follow `MockValue` —
  a single `MockObject` for a static mock or a `list[MockObject]`
  for a stateful mock consumed in order, then `mocks_exhausted` once
  the list is drained. Absent case stays wire-neutral (no `mocks`
  key on the body). The SDK does not rewrite tool names, so the
  double-underscore form (`asaas__create_payment`) surfaces as
  `mocks_invalid` from the backend rather than being silently
  rewritten.
- `MockObject` and `MockValue` type aliases re-exported from
  `codespar`. `SessionConfig` widens to accept the optional
  `mocks: dict[str, MockValue] | None` field.
- `CodesparApiError` exception (TypeScript parallel); Python's
  `ApiError` retains its existing shape, and the new test-mode
  envelopes (`mocks_not_permitted`, `mocks_invalid`,
  `mocks_payload_too_large`) flow through it with the `code`
  discriminant preserved.
- `tool_result_codes` module (`src/codespar/tool_result_codes.py`).
  Five frozen dataclasses — `PolicyDeniedOutput`,
  `ApprovalRequiredOutput`, `MocksExhaustedOutput`,
  `MocksEngineErrorOutput`, `ToolNotMockedOutput` — plus the
  `ToolResultCode` `Literal` union, the `TOOL_RESULT_CODES`
  `frozenset`, five `TypeGuard` predicates (`is_policy_denied`,
  `is_approval_required`, `is_mocks_exhausted`,
  `is_mocks_engine_error`, `is_tool_not_mocked`), and
  `assert_exhaustive_tool_result` for exhaustive `match` over the
  union. Each guard checks the `code` discriminant AND its required
  sibling fields, so a payload with a well-formed `code` but a
  missing `rule_id` / `approval_id` / `tool_name` returns `False`
  rather than narrowing positive.
- `CODESPAR_BASE_URL` environment variable resolved in both the
  `CodeSpar` and `AsyncCodeSpar` constructors. Cascade: explicit
  `base_url` option, then `CODESPAR_BASE_URL`, then
  `https://api.codespar.dev`. Point the same client wiring at a
  [local OSS runtime](https://github.com/codespar/codespar) without
  rebuilding call sites.
- Test fixture `tests/_fixtures/mocks_canonical.json` for wire
  parity between languages.

### Changed

- `_http.py` honors `code` over `error` when both are present on a
  non-success response body. The new test-mode envelopes carry
  `code`; pre-test-mode responses that only set `error` remain
  compatible.
- User-Agent bumped to `codespar-python/0.10.0`.

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
