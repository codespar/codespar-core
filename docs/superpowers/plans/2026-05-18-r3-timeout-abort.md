# R3 Request Timeout + Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `@codespar/sdk` (TS) and `codespar` (Python) network call a default timeout and a caller-driven cancellation path, with parity on the timeout knob.

**Architecture:** TS adds a `mergeSignals` combinator + a `fetchWithTimeout` helper used by unary methods, and an idle-reset timer in the two SSE parsers; a new `TimeoutError` distinguishes timeout from caller-abort. Python threads an optional `timeout` through the existing `_http.py` choke points (`request_json` / `stream_sse` / `stream_sse_get`) and maps `httpx.TimeoutException` to a new `TimeoutError`.

**Tech Stack:** TypeScript 5 (Node ≥20, native `fetch`/`AbortSignal`), Vitest; Python 3.10+, `httpx>=0.27`, pytest + pytest-httpx.

**Spec:** `docs/superpowers/specs/2026-05-18-r3-timeout-abort-design.md`

**Branch:** `feat/sdk-request-timeout-abort` (already created off `main`; spec already committed there as `c8671d5`).

**Node constraint:** `packages/core/package.json` has `engines.node: ">=20"`. `AbortSignal.any` is Node 20.3+, so this plan uses a manual `mergeSignals` combinator (works on any Node 20). `AbortSignal.timeout` is Node 17.3+ and is safe.

---

## File Structure

**TypeScript (`packages/core/`):**
- Create `src/errors.ts` — `TimeoutError` class.
- Create `src/internal/abort.ts` — `mergeSignals(signals)` + `timeoutSignal(ms)` helpers.
- Create `src/internal/fetch.ts` — `fetchWithTimeout(url, init, { timeout, signal })` (unary).
- Modify `src/types.ts` — add `timeout?: number` to `CodeSparConfig`; add exported `CallOptions` type.
- Modify `src/index.ts` — default + re-export `TimeoutError`; thread client `timeout` into `createSession` deps.
- Modify `src/session.ts` — `SessionDeps` gains `timeout`; unary methods use `fetchWithTimeout`; `sendStream` + status streams gain `CallOptions` and idle timeout; both SSE parsers gain an idle-reset hook.
- Tests: `src/__tests__/abort.test.ts`, `src/__tests__/fetch-timeout.test.ts`, `src/__tests__/stream-timeout.test.ts`.

**Python (`packages/python/`):**
- Modify `src/codespar/errors.py` — add `TimeoutError(CodeSparError)`.
- Modify `src/codespar/__init__.py` — export `TimeoutError`.
- Modify `src/codespar/_http.py` — `request_json` / `stream_sse` / `stream_sse_get` accept optional `timeout`; catch `httpx.TimeoutException` → `TimeoutError`.
- Modify `src/codespar/_async_client.py` / `_async_session.py` — pass per-call `timeout` through to `_http` helpers.
- Tests: `tests/test_timeout.py`.

Phases are independently testable/committable: **Phase 1 = TS**, **Phase 2 = Python**.

---

## Phase 1 — TypeScript

### Task 1: `mergeSignals` + `timeoutSignal` helpers

**Files:**
- Create: `packages/core/src/internal/abort.ts`
- Test: `packages/core/src/__tests__/abort.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/abort.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mergeSignals, timeoutSignal } from "../internal/abort.js";

afterEach(() => vi.useRealTimers());

describe("mergeSignals", () => {
  it("aborts when any input signal aborts, with that signal's reason", () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = mergeSignals([a.signal, b.signal]);
    expect(signal.aborted).toBe(false);
    const reason = new Error("from-b");
    b.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
  });

  it("is already aborted if an input is already aborted", () => {
    const a = new AbortController();
    a.abort(new Error("pre"));
    const { signal } = mergeSignals([a.signal]);
    expect(signal.aborted).toBe(true);
  });

  it("cleanup() detaches listeners and does not abort the merged signal", () => {
    const a = new AbortController();
    const { signal, cleanup } = mergeSignals([a.signal]);
    cleanup();
    a.abort(new Error("late"));
    expect(signal.aborted).toBe(false);
  });
});

describe("timeoutSignal", () => {
  it("aborts after the given ms with a TimeoutError-named reason", () => {
    vi.useFakeTimers();
    const { signal } = timeoutSignal(1000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe("TimeoutError");
  });

  it("clear() prevents the abort", () => {
    vi.useFakeTimers();
    const { signal, clear } = timeoutSignal(1000);
    clear();
    vi.advanceTimersByTime(5000);
    expect(signal.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/abort.test.ts`
Expected: FAIL — cannot resolve `../internal/abort.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/internal/abort.ts

/**
 * Merge several AbortSignals into one. The merged signal aborts as soon
 * as any input aborts, carrying that input's reason. Node >=20 may lack
 * AbortSignal.any (20.3+), so this is a manual combinator.
 */
export function mergeSignals(
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal; cleanup: () => void } {
  const present = signals.filter((s): s is AbortSignal => !!s);
  const controller = new AbortController();

  const already = present.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }

  const onAbort = (ev: Event) => {
    const target = ev.target as AbortSignal;
    controller.abort(target.reason);
    cleanup();
  };
  for (const s of present) s.addEventListener("abort", onAbort);

  function cleanup() {
    for (const s of present) s.removeEventListener("abort", onAbort);
  }
  return { signal: controller.signal, cleanup };
}

/**
 * An AbortSignal that aborts after `ms`, with a reason whose `.name`
 * is "TimeoutError" so callers can tell timeout from caller-abort.
 */
export function timeoutSignal(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const reason = new Error(`Request timed out after ${ms}ms`);
  reason.name = "TimeoutError";
  const id = setTimeout(() => controller.abort(reason), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/abort.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/internal/abort.ts packages/core/src/__tests__/abort.test.ts
git commit -m "feat(sdk): internal mergeSignals + timeoutSignal helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `TimeoutError` class

**Files:**
- Create: `packages/core/src/errors.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Test: extend `packages/core/src/__tests__/abort.test.ts`

- [ ] **Step 1: Write the failing test** (append to `abort.test.ts`)

```ts
import { TimeoutError } from "../errors.js";

describe("TimeoutError", () => {
  it("is an Error subclass with name TimeoutError and a timeoutMs field", () => {
    const e = new TimeoutError(1234);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TimeoutError");
    expect(e.timeoutMs).toBe(1234);
    expect(e.message).toMatch(/1234/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/abort.test.ts`
Expected: FAIL — cannot resolve `../errors.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/errors.ts

/** Thrown when a request exceeds its timeout (unary total, or stream idle). */
export class TimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`CodeSpar request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}
```

Add to `packages/core/src/index.ts` after the existing `export { tools, findTools } from "./tools.js";` line:

```ts
export { TimeoutError } from "./errors.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/abort.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/index.ts packages/core/src/__tests__/abort.test.ts
git commit -m "feat(sdk): export TimeoutError

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `fetchWithTimeout` (unary helper)

**Files:**
- Create: `packages/core/src/internal/fetch.ts`
- Test: `packages/core/src/__tests__/fetch-timeout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/fetch-timeout.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout } from "../internal/fetch.js";
import { TimeoutError } from "../errors.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWithTimeout", () => {
  it("passes a signal to fetch and returns the response on success", async () => {
    const res = { ok: true, status: 200 } as Response;
    const spy = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return res;
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    const out = await fetchWithTimeout("https://x/y", { method: "GET" }, { timeout: 1000 });
    expect(out).toBe(res);
  });

  it("throws TimeoutError when the timeout fires before fetch resolves", async () => {
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    await expect(
      fetchWithTimeout("https://x/y", {}, { timeout: 5 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("re-throws the caller's AbortError when the caller signal aborts", async () => {
    const ac = new AbortController();
    globalThis.fetch = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as unknown as typeof fetch;
    const p = fetchWithTimeout("https://x/y", {}, { timeout: 9999, signal: ac.signal });
    const reason = new DOMException("aborted", "AbortError");
    ac.abort(reason);
    await expect(p).rejects.toBe(reason);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/fetch-timeout.test.ts`
Expected: FAIL — cannot resolve `../internal/fetch.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/internal/fetch.ts
import { mergeSignals, timeoutSignal } from "./abort.js";
import { TimeoutError } from "../errors.js";

export interface CallOptions {
  /** Per-call timeout in ms. Overrides the client default for this call. */
  timeout?: number;
  /** Caller AbortSignal. Aborting rejects with the caller's reason. */
  signal?: AbortSignal;
}

/**
 * fetch() with a total timeout. The timeout fires a TimeoutError; the
 * caller's own signal aborting re-throws that signal's reason verbatim
 * (a standard AbortError), so the two causes stay distinguishable.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: { timeout: number; signal?: AbortSignal },
): Promise<Response> {
  const t = timeoutSignal(opts.timeout);
  const merged = mergeSignals([t.signal, opts.signal]);
  try {
    return await fetch(url, { ...init, signal: merged.signal });
  } catch (err) {
    if (t.signal.aborted && (!opts.signal || !opts.signal.aborted)) {
      throw new TimeoutError(opts.timeout);
    }
    throw err;
  } finally {
    t.clear();
    merged.cleanup();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/fetch-timeout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/internal/fetch.ts packages/core/src/__tests__/fetch-timeout.test.ts
git commit -m "feat(sdk): fetchWithTimeout unary helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `CodeSparConfig.timeout` + thread into `createSession` deps

**Files:**
- Modify: `packages/core/src/types.ts` (CodeSparConfig, ~lines 6-13; export `CallOptions`)
- Modify: `packages/core/src/index.ts` (default + pass to `createSession`)
- Modify: `packages/core/src/session.ts` (`SessionDeps` interface, ~lines 31-35)
- Test: `packages/core/src/__tests__/codespar.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `codespar.test.ts` inside `describe("CodeSpar constructor")`)

```ts
  it("defaults timeout to 60000 and accepts an override", () => {
    const a = new CodeSpar({ apiKey: "csk_live_t" });
    // @ts-expect-error private config read for the test only
    expect(a.config.timeout).toBe(60000);
    const b = new CodeSpar({ apiKey: "csk_live_t", timeout: 5000 });
    // @ts-expect-error private config read for the test only
    expect(b.config.timeout).toBe(5000);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/codespar.test.ts -t "defaults timeout"`
Expected: FAIL — `config.timeout` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/types.ts`, add to `CodeSparConfig` (after `projectId?`):

```ts
  /** Default per-request timeout in ms. Default 60000. */
  timeout?: number;
```

Append to `types.ts` (end of file):

```ts
/** Per-call request options. */
export interface CallOptions {
  /** Per-call timeout in ms; overrides the client default. */
  timeout?: number;
  /** Caller AbortSignal. */
  signal?: AbortSignal;
}
```

In `packages/core/src/index.ts`, change the `this.config` assignment to include:

```ts
      timeout: config.timeout ?? 60000,
```

and change the `createSession(...)` call to pass `timeout: this.config.timeout` in the deps object.

In `packages/core/src/session.ts`, extend `SessionDeps`:

```ts
interface SessionDeps {
  baseUrl: string;
  apiKey: string;
  projectId?: string;
  timeout: number;
}
```

Also export `CallOptions` from `index.ts` (add to the existing `export type { ... } from "./types.js";` block).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/codespar.test.ts -t "defaults timeout"`
Then full: `npx vitest run packages/core && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts packages/core/src/session.ts packages/core/src/__tests__/codespar.test.ts
git commit -m "feat(sdk): CodeSparConfig.timeout (default 60000) + CallOptions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Apply `fetchWithTimeout` to unary methods

Wire `fetchWithTimeout` into every non-stream `fetch` in `session.ts`,
adding an optional `opts?: CallOptions` arg where the method is public.
The effective timeout is `opts?.timeout ?? deps.timeout`.

**Files:**
- Modify: `packages/core/src/session.ts` (`createSession` POST; `execute`; `proxyExecute`; `send`; `connections`; `authorize`)
- Test: `packages/core/src/__tests__/fetch-timeout.test.ts` (append integration test)

- [ ] **Step 1: Write the failing test** (append)

```ts
import { CodeSpar } from "../index.js";

it("execute() rejects with TimeoutError when the backend hangs", async () => {
  globalThis.fetch = ((url: string, init: RequestInit) => {
    if (String(url).endsWith("/v1/sessions")) {
      return Promise.resolve({
        ok: true, status: 201, text: async () => "",
        json: async () => ({
          id: "ses_h", org_id: "o", user_id: "u", servers: [],
          status: "active", created_at: new Date().toISOString(), closed_at: null,
        }),
      } as Response);
    }
    // /execute hangs until aborted
    return new Promise((_r, reject) =>
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason)),
    );
  }) as unknown as typeof fetch;

  const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 10 });
  const session = await cs.create("u");
  await expect(session.execute("t", {})).rejects.toBeInstanceOf(TimeoutError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/fetch-timeout.test.ts -t "backend hangs"`
Expected: FAIL — promise never rejects (no timeout wired), test times out.

- [ ] **Step 3: Write minimal implementation**

In `session.ts`, replace each unary `await fetch(URL, INIT)` with
`await fetchWithTimeout(URL, INIT, { timeout: opts?.timeout ?? deps.timeout, signal: opts?.signal })`.
Add `import { fetchWithTimeout } from "./internal/fetch.js";` and
`import type { CallOptions } from "./types.js";`. Concretely:

- `createSession` POST `/v1/sessions` — no public `opts`; use `{ timeout: deps.timeout }`.
- `execute(toolName, params, opts?: CallOptions)` — signature gains `opts?`; wrap its `fetch`.
- `proxyExecute(request, opts?: CallOptions)` — gains `opts?`; wrap.
- `send(message, opts?: CallOptions)` — gains `opts?`; wrap.
- `connections(opts?: CallOptions)` — gains `opts?`; wrap. (Internal callers `tools()` / `waitForConnections` call `session.connections()` with no args — unchanged, they use `deps.timeout`.)
- `authorize(serverId, config, opts?: CallOptions)` — gains `opts?`; wrap.

The wrappers `discover` / `connectionWizard` / `charge` / `ship` call
`session.execute(...)` — add an optional `opts?: CallOptions` passed
through to `execute`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: all PASS (existing tests unaffected — they resolve fast, before the 60000ms default); new test PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session.ts packages/core/src/__tests__/fetch-timeout.test.ts
git commit -m "feat(sdk): apply request timeout + signal to unary session methods

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Idle timeout for SSE streams

`sendStream` and the status streams must abort if no SSE event arrives
within the timeout window; a steady stream stays alive. The two parsers
(`parseSseStream`, `parseStatusSseStream`) get an `onEvent`-driven idle
reset by wrapping their `fetch` and reader loop.

**Files:**
- Modify: `packages/core/src/session.ts` (`sendStream`, `paymentStatusStream`, `verificationStatusStream`, `parseSseStream`, `parseStatusSseStream`)
- Test: `packages/core/src/__tests__/stream-timeout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/__tests__/stream-timeout.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { CodeSpar } from "../index.js";
import { TimeoutError } from "../errors.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers(); });

function sse(chunks: string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (i >= chunks.length) return new Promise(() => {}); // then idle forever
      const c = chunks[i++]!;
      return new Promise((r) => setTimeout(() => { ctrl.enqueue(enc.encode(c)); r(); }, gapMs));
    },
  });
}

function sessionCreate(): Response {
  return { ok: true, status: 201, text: async () => "", json: async () => ({
    id: "ses_s", org_id: "o", user_id: "u", servers: [],
    status: "active", created_at: new Date().toISOString(), closed_at: null,
  }) } as Response;
}

it("sendStream throws TimeoutError when the stream goes idle past the window", async () => {
  globalThis.fetch = ((url: string) => {
    if (String(url).endsWith("/v1/sessions")) return Promise.resolve(sessionCreate());
    return Promise.resolve({ ok: true, body:
      sse(['event: assistant_text\ndata: {"content":"hi","iteration":1}\n\n'], 0) } as Response);
  }) as unknown as typeof fetch;

  const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://x", timeout: 50 });
  const session = await cs.create("u");
  await expect(async () => {
    for await (const _ of session.sendStream("hi")) { /* drain; stream idles after 1 event */ }
  }).rejects.toBeInstanceOf(TimeoutError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/stream-timeout.test.ts`
Expected: FAIL — the async iterator hangs (no idle timeout), test times out.

- [ ] **Step 3: Write minimal implementation**

Add an idle-timer parameter to the parsers. Change `parseSseStream` and
`parseStatusSseStream` to accept `idleMs: number` and `extSignal?: AbortSignal`:

```ts
async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  onIdle: () => void,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(timer); timer = setTimeout(onIdle, idleMs); };
  try {
    arm();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // reset idle window on any byte
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = parseSseChunk(chunk);
        if (event) yield event;
      }
    }
    if (buffer.trim()) { const e = parseSseChunk(buffer); if (e) yield e; }
  } finally {
    clearTimeout(timer!);
    reader.releaseLock();
  }
}
```

In `sendStream(message, opts?: CallOptions)`: compute
`const ms = opts?.timeout ?? deps.timeout;`, create
`const t = timeoutSignal(ms);` and
`const merged = mergeSignals([t.signal, opts?.signal]);`, pass
`merged.signal` to the `fetch`, and pass an `onIdle` that aborts the
reader by calling the merged controller — simplest: have `onIdle` call
a local `AbortController` that is also merged, then in the catch map
`t`/idle abort → `throw new TimeoutError(ms)`; caller-signal abort →
rethrow. Clear `t` and `merged` in `finally`. Apply the same pattern to
`paymentStatusStream` / `verificationStatusStream` using
`parseStatusSseStream` (give it the identical `idleMs`/`onIdle` params).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: new test PASS; existing stream behavior unaffected; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session.ts packages/core/src/__tests__/stream-timeout.test.ts
git commit -m "feat(sdk): idle timeout for SSE streams (sendStream + status streams)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Document the known limitation

**Files:**
- Modify: `packages/core/src/internal/fetch.ts` (top-of-file comment)

- [ ] **Step 1: Add the comment**

```ts
// LIMITATION: aborting/timing out only closes the client connection.
// It does NOT undo an upstream side effect the backend already
// dispatched (e.g. a Pix transfer / NF-e issuance). HTTP has no
// out-of-band cancel; the server only learns the socket closed. True
// cancellation of a side-effecting call needs a backend cancel
// endpoint or idempotency key. Tracked separately (not in R3).
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/internal/fetch.ts
git commit -m "docs(sdk): note client-abort cannot undo upstream side effects

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 — Python

### Task 8: `TimeoutError` exception + export

**Files:**
- Modify: `packages/python/src/codespar/errors.py`
- Modify: `packages/python/src/codespar/__init__.py`
- Test: `packages/python/tests/test_timeout.py`

- [ ] **Step 1: Write the failing test**

```python
# packages/python/tests/test_timeout.py
from codespar import CodeSparError, TimeoutError as CsTimeoutError


def test_timeout_error_is_codespar_error() -> None:
    e = CsTimeoutError("slow")
    assert isinstance(e, CodeSparError)
    assert str(e) == "slow"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/python && .venv/bin/python -m pytest tests/test_timeout.py -q`
Expected: FAIL — `ImportError: cannot import name 'TimeoutError'`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/python/src/codespar/errors.py`:

```python
class TimeoutError(CodeSparError):
    """Raised when a request exceeds its timeout (unary or stream idle)."""
```

In `packages/python/src/codespar/__init__.py`, add `TimeoutError` to the
`from .errors import (...)` block and to `__all__`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/python && .venv/bin/python -m pytest tests/test_timeout.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/python/src/codespar/errors.py packages/python/src/codespar/__init__.py packages/python/tests/test_timeout.py
git commit -m "feat(python): add and export TimeoutError

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `_http.py` — timeout passthrough + map `httpx.TimeoutException`

**Files:**
- Modify: `packages/python/src/codespar/_http.py` (`request_json` ~line 42, `stream_sse` ~line 90, `stream_sse_get` ~line 143)
- Test: `packages/python/tests/test_timeout.py` (append)

- [ ] **Step 1: Write the failing test** (append)

```python
import httpx
import pytest
from codespar import AsyncCodeSpar, TimeoutError as CsTimeoutError


async def test_create_maps_httpx_timeout(httpx_mock) -> None:
    httpx_mock.add_exception(httpx.ReadTimeout("slow"))
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        with pytest.raises(CsTimeoutError):
            await cs.create("user_1", preset="brazilian")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/python && .venv/bin/python -m pytest tests/test_timeout.py -q -k httpx_timeout`
Expected: FAIL — raises `ApiError`/raw `httpx.ReadTimeout`, not `TimeoutError`.

- [ ] **Step 3: Write minimal implementation**

In `_http.py`, add `from .errors import TimeoutError` (with the other
error imports). In `request_json`, add an optional
`timeout: float | None = None` parameter and pass `timeout=timeout` to
`client.request(...)`. Before the existing
`except httpx.HTTPError as exc:` add a more specific handler:

```python
    except httpx.TimeoutException as exc:
        raise TimeoutError(str(exc), cause=exc) from exc
```

(`TimeoutException` is a subclass of `HTTPError`, so it must be caught
first.) Apply the identical `timeout` parameter + `TimeoutException`
handler to `stream_sse` and `stream_sse_get` (pass `timeout=timeout`
into their `client.stream(...)` calls).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/python && .venv/bin/python -m pytest tests/test_timeout.py -q && .venv/bin/python -m mypy src && .venv/bin/python -m ruff check src tests`
Expected: PASS; mypy + ruff clean.

- [ ] **Step 5: Commit**

```bash
git add packages/python/src/codespar/_http.py packages/python/tests/test_timeout.py
git commit -m "feat(python): map httpx.TimeoutException to TimeoutError + timeout passthrough

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Per-call `timeout` through client + session methods

**Files:**
- Modify: `packages/python/src/codespar/_async_client.py` (`create`)
- Modify: `packages/python/src/codespar/_async_session.py` (methods that call `request_json` / `stream_sse*`)
- Test: `packages/python/tests/test_timeout.py` (append)

- [ ] **Step 1: Write the failing test** (append)

```python
async def test_per_call_timeout_is_forwarded(httpx_mock, monkeypatch) -> None:
    seen: dict = {}
    import codespar._http as http_mod
    real = http_mod.request_json

    async def spy(client, method, path, /, **kw):
        seen["timeout"] = kw.get("timeout")
        return await real(client, method, path, **kw)

    monkeypatch.setattr(http_mod, "request_json", spy)
    httpx_mock.add_response(
        url="https://api.codespar.dev/v1/sessions", method="POST",
        json={"id": "s", "org_id": "o", "user_id": "u", "servers": [],
              "status": "active", "created_at": "2026-01-01T00:00:00Z",
              "closed_at": None},
    )
    async with AsyncCodeSpar(api_key="csk_test_x") as cs:
        await cs.create("u", preset="brazilian", timeout=12.5)
    assert seen["timeout"] == 12.5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/python && .venv/bin/python -m pytest tests/test_timeout.py -q -k per_call`
Expected: FAIL — `create()` rejects unknown kwarg `timeout` or `seen["timeout"]` is `None`.

- [ ] **Step 3: Write minimal implementation**

In `_async_client.create`, accept an optional `timeout: float | None`
(add to the `allowed` kwargs set in `_resolve_config` is NOT correct —
`timeout` is not a `SessionConfig` field; instead add it as an explicit
keyword on `create` alongside `user_id`). Pass `timeout=timeout` into
the `request_json(...)` call. Thread an optional `timeout` parameter
into the `AsyncSession` methods that perform requests
(`execute`, `send`, `send_stream`, `proxy_execute`, `connections`,
`authorize`, the status streams) and forward to the `_http` helpers.
Default `None` everywhere → falls back to the client-level
`httpx` timeout (already 60.0).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/python && .venv/bin/python -m pytest -q && .venv/bin/python -m mypy src && .venv/bin/python -m ruff check src tests`
Expected: all PASS; mypy + ruff clean.

- [ ] **Step 5: Commit**

```bash
git add packages/python/src/codespar/_async_client.py packages/python/src/codespar/_async_session.py packages/python/tests/test_timeout.py
git commit -m "feat(python): per-call timeout passthrough on client + session methods

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Document the Python cancellation idiom

**Files:**
- Modify: `packages/python/src/codespar/_async_client.py` (class docstring)

- [ ] **Step 1: Add to the `AsyncCodeSpar` docstring**

```
Cancellation: there is no AbortSignal in Python. Cancel an in-flight
call by cancelling the awaiting asyncio task (e.g. asyncio.timeout()
or task.cancel()); httpx tears the connection down. Note this only
closes the connection — it does not undo an upstream side effect the
backend already dispatched.
```

- [ ] **Step 2: Commit**

```bash
git add packages/python/src/codespar/_async_client.py
git commit -m "docs(python): document asyncio cancellation idiom + side-effect caveat

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase 3 — Verify + finish

### Task 12: Full green + finish branch

- [ ] **Step 1: TS full suite + typecheck**

Run: `npx vitest run packages/core && npx tsc --noEmit -p packages/core/tsconfig.json`
Expected: all PASS; tsc exit 0.

- [ ] **Step 2: Python full suite + mypy + ruff**

Run: `cd packages/python && .venv/bin/python -m pytest -q && .venv/bin/python -m mypy src && .venv/bin/python -m ruff check src tests`
Expected: all PASS; mypy + ruff clean.

- [ ] **Step 3: Monorepo build (adapters consume `@codespar/sdk`)**

Run: `npm run build`
Expected: all Turbo tasks succeed.

- [ ] **Step 4: Finish the development branch**

Invoke `superpowers:finishing-a-development-branch` to choose how to
integrate (the established flow here is a cross-fork PR to
`codespar/codespar-core`; "Behavior change: adds a default 60s timeout"
must be called out in the PR body, mirroring #37/#38).

---

## Self-Review

**Spec coverage:**
- Both timeout + cancellation → Tasks 1,3,5,6 (TS), 9,10 (Python). ✓
- Client-level + per-call override → Task 4 (config), Task 5/6 (`opts?.timeout ?? deps.timeout`), Task 10 (Python per-call). ✓
- TS + Python parity (timeout) → Phase 1 + Phase 2. ✓
- Idle timeout streams → Task 6 (TS), Task 9 (httpx `read` timeout). ✓
- Unary total timeout → Tasks 3, 5. ✓
- `TimeoutError` both SDKs → Task 2 (TS), Task 8 (Python). ✓
- Cause distinction (timeout vs caller abort) → Task 3 test + impl. ✓
- Default 60s single value → Task 4 (TS), client httpx default already 60.0 (Python). ✓
- Known limitation documented → Task 7 (TS), Task 11 (Python). ✓
- Node 20.3 risk → resolved up front via manual `mergeSignals` (Task 1). ✓
- `waitForConnections` untouched → Task 5 explicitly leaves no-arg internal callers on `deps.timeout`. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code; commands have expected output.

**Type consistency:** `CallOptions` defined in Task 4 (`types.ts`), used in Tasks 5/6. `fetchWithTimeout` signature defined Task 3, used Task 5. `timeoutSignal`/`mergeSignals` defined Task 1, used Tasks 3/6. `TimeoutError(timeoutMs)` defined Task 2, thrown in Tasks 3/6. Python `TimeoutError(message, *, cause=...)` uses the existing `CodeSparError.__init__` signature (Task 8 → used Task 9). Consistent.
