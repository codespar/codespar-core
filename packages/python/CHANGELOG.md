# codespar (Python SDK) — CHANGELOG

## 0.15.1

The 0.15.0 release never reached PyPI: `publish-python.yml` stops at `ruff check` and
the documents change had 24 findings (import blocks, `__all__` order, lines over 100).
No API change; the package is 0.15.0 with the lint clean.

### Fixed

- `ruff check src/ tests/`, `mypy src/codespar` and `pytest` all green on the package;
  the gate stays in the publication workflow (the repository's `ci.yml` has no Python job).

## 0.15.0

Documents on demand, in parity with `@codespar/sdk` 0.16.22 (`CONTRATO-documentos`).

### Added

- `cs.receipts.document(receipt_id, *, format="pdf"|"png")` and
  `cs.account.statement(from_date, to_date, *, format="pdf", currency=None)` on `CodeSpar` and
  `AsyncCodeSpar`, returning a `Document` TypedDict (`bytes`, `content_type`, `filename`,
  `sha256`). Refusals are `ApiError` with the API's code (`document_not_final`,
  `statement_period_invalid`, `statement_not_reconciled`, `document_renderer_unavailable`).
- `filename_from_disposition(header)`.

## 0.14.0

`cs.wallet.pix_keys`, in parity with `@codespar/sdk` 0.16.21.

### Added

- `cs.wallet.pix_keys.list(consumer_id)`, `.register(consumer_id, key_type="EVP", key=None)`
  and `.delete(consumer_id, key, confirm=True)` on `CodeSpar` and
  `AsyncCodeSpar`, over `/v1/consumers/:consumer_id/pix-keys`. A delete
  without `confirm=True` raises `PixKeyDeleteNotConfirmedError`
  (`pix_key_delete_requires_confirmation`, with the consequence sentence)
  before any request. Types `PixKey`, `PixKeyList`, `PixKeyRegistered`,
  `PixKeyDeleted`, `PixKeyType`.

## 0.13.0

`cs.payables`, in parity with `@codespar/sdk` 0.16.19.

### Added

- `cs.payables.files.upload(file, *, filename=None, content_type=None)` on
  `CodeSpar` and `AsyncCodeSpar`: `file` is a path (`str`/`PathLike`), `bytes`
  or a binary file object; posts multipart to `POST /v1/payables/files`.
- `cs.payables.batches.create(*, file_ids=None, items=None, source=None, conversation_id=None, idempotency_key=None)`,
  `get(batch_id)`, `update_item(batch_id, item_id, *, expected_version, ...)`,
  `add_items(batch_id, *, expected_version, file_ids=None, items=None)` and
  `pay(batch_id, *, version, list_hash, mandate_id=None, idempotency_key=None)`.
  Responses are the wire shape as `TypedDict`s (`PayableFile`,
  `PayableBatch`, `PayableBatchItem`). `create` sends a fresh
  `Idempotency-Key` unless given one; `pay` derives it from the batch,
  version and list hash. `payable_batch_from_error(err)` returns the current
  batch a 409 carries in `error.details.batch`. `pay` repeats the same call
  while the API answers `executing` with items still `ready` (up to 30
  calls), as the TS SDK does.
- `_http.request_json` takes `files=` (multipart, boundary written by httpx)
  and `extra_headers=`.
- `__version__` says `0.13.0`.

### Fixed

- `ApiError.code` and the message read the nested envelope newer routes
  answer, `{"error": {"code", "message", "details"}}`; `code` was `None`
  for those. A top-level `code` still wins, then the nested one, then a
  legacy `error` string.

## 0.12.0

`codespar.mandate` is strict, in parity with `@codespar/sdk/mandate` 0.16.11
and `codespar mandate verify` 0.17.0 (codespar-core#123, p2-identity#6).

### Changed

- `verify_mandate_token(...).verified` is `True` only when both Ed25519
  signatures are carried and verify, the agent's under the key the token
  names, and the token is not expired. It used to be `True` with the agent
  signature stripped, with a signature left unchecked (no key given), and
  after `expires_at`. `verify_mandate_token(t, agent_public_key=...)` alone is
  now `verified=False` with `failures == ["issuer_sig_unchecked"]`.
- The key is the one the signed `agent_kid` names; an envelope `kid` that
  differs is refused (`kid_mismatch`).
- `__version__` says `0.12.0`; it had said `0.10.2` through 0.11.0.

### Added

- `agent_did_document=`: the agent's parsed did:web document; only the
  `verificationMethod` whose `id` equals the signed `agent_kid` is used, so a
  retired key listed beside the active one does not verify a token naming the
  active one. Mutually exclusive with `agent_public_key` (`TypeError`).
- `now=` (UNIX seconds) for the expiry check; default is the current time.
- `MandateVerification.failures`, `.expired`, `.issued_at`.
- V4 tokens (`format_version: 4`, signed `issued_at`), byte-locked against the
  enterprise fixture. An unknown later format raises
  `MandateDecodeError("mandate_format_unsupported")`.

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
