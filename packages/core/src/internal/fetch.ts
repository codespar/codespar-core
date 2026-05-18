import { mergeSignals, timeoutSignal } from "./abort.js";
import { TimeoutError } from "../errors.js";

export type { CallOptions } from "../types.js";

/**
 * fetch() with a total timeout. The timeout fires a TimeoutError; the
 * caller's own signal aborting re-throws that signal's reason verbatim
 * (a standard AbortError), so the two causes stay distinguishable.
 */
export async function fetchWithTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  opts: { timeout: number; signal?: AbortSignal },
): Promise<Response> {
  const t = timeoutSignal(opts.timeout);
  const merged = mergeSignals([t.signal, opts.signal]);
  try {
    return await fetch(url, { ...init, signal: merged.signal });
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
