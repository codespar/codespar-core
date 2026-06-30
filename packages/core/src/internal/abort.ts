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
    const source = ev.currentTarget as AbortSignal;
    controller.abort(source.reason);
    cleanup();
  };
  for (const s of present) s.addEventListener("abort", onAbort);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
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
