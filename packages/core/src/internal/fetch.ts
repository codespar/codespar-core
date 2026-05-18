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
