// LIMITATION: aborting/timing out only closes the client connection.
// It does NOT undo an upstream side effect the backend already
// dispatched (e.g. a Pix transfer / NF-e issuance). HTTP has no
// out-of-band cancel; the server only learns the socket closed. True
// cancellation of a side-effecting call needs a backend cancel
// endpoint or idempotency key. Tracked separately (not in R3).

import { mergeSignals, timeoutSignal } from "./abort.js";
import { TimeoutError } from "../errors.js";

export type { CallOptions } from "../types.js";

/**
 * fetch() with a TOTAL timeout that covers body consumption too.
 *
 * The `consume` callback reads the body (`res.json()`/`res.text()`)
 * while the timeout signal is still armed — a backend that returns
 * headers and then stalls the body still hits the timeout instead of
 * hanging forever. The timeout fires a TimeoutError; the caller's own
 * signal aborting re-throws that signal's reason verbatim (a standard
 * AbortError), so the two causes stay distinguishable.
 */
export async function fetchWithTimeout<T>(
  url: string,
  init: Omit<RequestInit, "signal">,
  opts: { timeout: number; signal?: AbortSignal },
  consume: (res: Response) => Promise<T>,
): Promise<T> {
  const t = timeoutSignal(opts.timeout);
  const merged = mergeSignals([t.signal, opts.signal]);
  try {
    const res = await fetch(url, { ...init, signal: merged.signal });
    // Body read stays inside the timeout/abort budget.
    return await consume(res);
  } catch (err) {
    // Caller cancellation takes priority and propagates verbatim.
    if (opts.signal?.aborted) throw opts.signal.reason;
    // Otherwise, if our timeout fired, surface a typed TimeoutError.
    if (t.signal.aborted) throw new TimeoutError(opts.timeout);
    // Unrelated failure (network/DNS/etc.) — rethrow as-is.
    throw err;
  } finally {
    t.clear();
    merged.cleanup();
  }
}
