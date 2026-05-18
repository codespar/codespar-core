# R3 — Request timeout + cancellation (TS + Python)

Date: 2026-05-18
Status: Approved (brainstorming) — ready for implementation plan
Scope: `packages/core` (`@codespar/sdk`) + `packages/python` (`codespar`)

## Problem

No SDK network call has a timeout or a caller-driven cancellation path.
A slow or dead backend leaves the **client** hung forever on an open
socket and a pending promise. Only the status-stream methods accept an
`AbortSignal` today; every other `fetch` (`createSession`, `execute`,
`send`, `sendStream`, `proxyExecute`, `connections`, `authorize`) has
none. The Python client has a client-level `httpx` timeout (`60.0`)
but no per-call override and no documented cancellation story.

Reference: `docs` audit item R3 (workspace `docs/fix-core.md`).

## Goals

1. A safe default timeout so a hung backend cannot hang the client
   forever.
2. Explicit caller cancellation of an in-flight request.
3. TS/Python parity on the timeout knob (cancellation idiom differs by
   language — see Non-goals).

## Decisions (locked in brainstorming)

| Topic | Decision |
|---|---|
| Driver | Both: automatic timeout (default) **and** caller cancellation |
| Timeout knob | Client-level default **+** per-call override |
| Parity | Timeout implemented in **TS + Python together** |
| Stream semantics | **Idle timeout** (resets on each event), not total |
| Unary semantics | Total/connect timeout |
| Error type | Dedicated `TimeoutError` exported in **both** SDKs |
| Default value | Single **60s** (60000 ms TS / 60.0 s Python) for unary timeout and stream idle window |

## API surface

### TypeScript

`CodeSparConfig` gains:

```ts
timeout?: number; // ms; default 60000
```

Network methods accept an optional trailing options object (additive,
backward-compatible):

```ts
type CallOptions = { timeout?: number; signal?: AbortSignal };

execute(tool, params, opts?: CallOptions)
send(message, opts?: CallOptions)
sendStream(message, opts?: CallOptions)        // gains signal + timeout
proxyExecute(request, opts?: CallOptions)
connections(opts?: CallOptions)
authorize(serverId, config, opts?: CallOptions)
paymentStatus / verificationStatus (+ *Stream) // already take signal; gain timeout
```

`createSession` (POST `/v1/sessions`) respects the client-level
timeout. Per-call `timeout` overrides the client default for that call;
`signal` is merged with the internal timeout signal.

### Python

- Constructor `timeout: float = 60.0` stays (already exists).
- Add per-call `timeout` passthrough: `create(..., timeout=...)`,
  `session.execute(..., timeout=...)`, etc., forwarded to the relevant
  `httpx` request/stream call.
- No `AbortSignal` equivalent: cancellation in async Python is task
  cancellation (`asyncio` cancel / `asyncio.timeout`), which already
  works without an API change. Documented in the client docstring.

### Not conflated

`SessionConfig.manageConnections.timeout` is a poll-wait budget for the
`waitForConnections` loop — a different concept. It is **not** changed
and **not** merged with the request timeout.

## Semantics

### Unary calls

`execute`, `send`, `proxyExecute`, `connections`, `authorize`,
`createSession`: a **total** timeout measured from request start
(includes body read).

- TS: build `AbortSignal.timeout(ms)`; merge with the caller's
  `signal`; pass the merged signal to `fetch`.
- Python: `httpx` per-request `timeout=` (a single value covers
  connect/read/write/pool).

### Streaming calls

`sendStream`, `paymentStatusStream`, `verificationStatusStream`:
**idle** timeout — a timer of `timeout` ms that is reset every time an
SSE event is parsed. If it fires, the underlying `fetch` is aborted and
the stream ends with `TimeoutError`.

- TS: a resettable timer wired into `parseSseStream` /
  `parseStatusSseStream`. The timer MUST be cleared on every exit path
  (normal `done`, error, caller abort) to avoid a leaked timer.
- Python: `httpx`'s `read` timeout is already the max gap between
  bytes — i.e. idle behavior for a stream. A single
  `httpx.Timeout(60.0)` gives this for free; per-call override flows
  through `client.stream(..., timeout=...)`.

### Defaults

One value, `60s` (60000 ms TS / 60.0 s Python — already Python's
default). Applies as the unary total timeout and the stream idle
window. Overridable per client and per call.

## Errors

New `TimeoutError`, exported by both SDKs, distinct from caller
cancellation:

- TS: `class TimeoutError extends Error` in a new
  `packages/core/src/errors.ts`, re-exported from the package entry.
  Thrown when the timeout fires. Distinguish cause by inspecting the
  abort `reason`: `AbortSignal.timeout()` aborts with a `TimeoutError`
  DOMException → map to our `TimeoutError`. A caller-supplied `signal`
  firing → let the standard `AbortError` propagate unwrapped.
- Python: `class TimeoutError(...)` in `codespar/errors.py` alongside
  `ConfigError` / `ApiError`. Wrap `httpx.TimeoutException` →
  `TimeoutError`. Let `asyncio.CancelledError` propagate unwrapped.

## Known limitation (documented, out of scope)

Client-side abort/timeout only closes the connection. It does **not**
undo an upstream side effect already initiated by the backend
(e.g. a Pix transfer or NF-e issuance already dispatched to an MCP
server / PSP). HTTP has no out-of-band "cancel this operation"
message; the server only learns the socket closed and may or may not
propagate cancellation. True cancellation of a side-effecting call
needs a backend cancel endpoint or idempotency key — a backend
feature. This will be captured as a code comment near the abort
plumbing and flagged as a candidate for a separate upstream issue.

## Implementation risks (for the plan)

- `AbortSignal.any([...])` (merge timeout + caller signal) is Node
  20.3+. If the SDK still targets Node 18, a manual signal combinator
  is needed. The plan must check `engines` in
  `packages/core/package.json` and pick the approach.
- The stream idle timer must be cleared on all exit paths or it leaks.
- TS distinguishing timeout vs caller-abort relies on `signal.reason`
  semantics — needs explicit unit coverage for both causes.

## Out of scope

- Backend cancel/idempotency endpoint.
- Changing `waitForConnections`.
- Retry-on-timeout (`loop()` already has its own retry policy).

## Test strategy (high level; detailed in the plan via TDD)

- Unary: timeout fires → `TimeoutError`; caller `signal` aborts →
  `AbortError`; per-call timeout overrides client default; success
  before timeout unaffected.
- Stream: idle gap > timeout → `TimeoutError`; steady events keep the
  stream alive past the window; caller abort mid-stream → `AbortError`;
  idle timer cleared on normal completion (no leak).
- Python: parity tests for client-level + per-call `timeout`,
  `httpx.TimeoutException` → `TimeoutError`, stream idle via `read`
  timeout.
- Both: `npm test` + `tsc --noEmit` green for `packages/core`;
  `pytest` + `mypy` + `ruff` green for `packages/python`.
