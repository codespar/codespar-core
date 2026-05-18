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
