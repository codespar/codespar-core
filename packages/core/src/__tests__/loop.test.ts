import { describe, it, expect, vi, afterEach } from "vitest";
import { loop } from "../loop.js";
import type { LoopStep } from "../types.js";
import type { SessionBase, ToolResult } from "@codespar/types";

const ok = (tool: string, data: unknown = {}): ToolResult => ({
  success: true,
  data,
  error: null,
  duration: 0,
  server: "test",
  tool,
});

const fail = (tool: string, error = "boom"): ToolResult => ({
  success: false,
  data: null,
  error,
  duration: 0,
  server: "test",
  tool,
});

/**
 * Minimal SessionBase whose execute() is driven by a per-call handler.
 * loop() only ever calls session.execute, so the rest are inert stubs.
 */
function recordingSession(
  handler: (tool: string, params: Record<string, unknown>) => Promise<ToolResult> | ToolResult,
): { session: SessionBase; calls: Array<{ tool: string; params: Record<string, unknown> }> } {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const session: SessionBase = {
    id: "ses_loop",
    status: "active",
    async execute(tool, params) {
      calls.push({ tool, params });
      return handler(tool, params);
    },
    async send() {
      return { message: "", tool_calls: [], iterations: 0 };
    },
    async *sendStream() {},
    async connections() {
      return [];
    },
    async close() {},
  };
  return { session, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("loop() — happy path", () => {
  it("runs all steps in order and reports completion", async () => {
    const { session, calls } = recordingSession((tool) => ok(tool));
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      { tool: "b", params: {} },
    ];

    const result = await loop(session, { steps });

    expect(result.success).toBe(true);
    expect(calls.map((c) => c.tool)).toEqual(["a", "b"]);
    expect(result.results.map((r) => r.tool)).toEqual(["a", "b"]);
    expect(result.completedSteps).toBe(2);
    expect(result.totalSteps).toBe(2);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("invokes onStepComplete per successful step with (step, result, index)", async () => {
    const { session } = recordingSession((tool) => ok(tool));
    const onStepComplete = vi.fn();
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      { tool: "b", params: {} },
    ];

    await loop(session, { steps, onStepComplete });

    expect(onStepComplete).toHaveBeenCalledTimes(2);
    expect(onStepComplete).toHaveBeenNthCalledWith(1, steps[0], expect.objectContaining({ tool: "a" }), 0);
    expect(onStepComplete).toHaveBeenNthCalledWith(2, steps[1], expect.objectContaining({ tool: "b" }), 1);
  });
});

describe("loop() — dynamic params and conditional steps", () => {
  it("calls step.params(prevResults) with prior results and forwards the return to execute", async () => {
    const { session, calls } = recordingSession((tool) => ok(tool, { id: `${tool}-1` }));
    const steps: LoopStep[] = [
      { tool: "create", params: { name: "Maria" } },
      {
        tool: "charge",
        params: (prev) => ({ ref: (prev[0]!.data as { id: string }).id }),
      },
    ];

    await loop(session, { steps });

    expect(calls[1]).toEqual({ tool: "charge", params: { ref: "create-1" } });
  });

  it("skips a step whose when() returns false", async () => {
    const { session, calls } = recordingSession((tool) => ok(tool));
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      { tool: "b", params: {}, when: () => false },
      { tool: "c", params: {} },
    ];

    const result = await loop(session, { steps });

    expect(calls.map((c) => c.tool)).toEqual(["a", "c"]);
    expect(result.results.map((r) => r.tool)).toEqual(["a", "c"]);
    expect(result.totalSteps).toBe(3);
    expect(result.completedSteps).toBe(2);
  });

  it("passes prevResults to when() so it can branch on earlier output", async () => {
    const { session, calls } = recordingSession((tool) => ok(tool, { skip: tool === "a" }));
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      {
        tool: "b",
        params: {},
        when: (prev) => !(prev[0]!.data as { skip: boolean }).skip,
      },
    ];

    await loop(session, { steps });

    expect(calls.map((c) => c.tool)).toEqual(["a"]);
  });
});

describe("loop() — failure handling", () => {
  it("aborts on first failure by default and reports it", async () => {
    const onStepError = vi.fn();
    const { session, calls } = recordingSession((tool) => (tool === "b" ? fail(tool) : ok(tool)));
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      { tool: "b", params: {} },
      { tool: "c", params: {} },
    ];

    const result = await loop(session, { steps, onStepError });

    expect(result.success).toBe(false);
    expect(calls.map((c) => c.tool)).toEqual(["a", "b"]);
    expect(result.completedSteps).toBe(1);
    expect(result.totalSteps).toBe(3);
    expect(onStepError).toHaveBeenCalledWith(steps[1], expect.any(Error), 1);
    expect(onStepError.mock.calls[0]![1].message).toBe("boom");
  });

  it("continues remaining steps when abortOnError is false", async () => {
    const { session, calls } = recordingSession((tool) => (tool === "b" ? fail(tool) : ok(tool)));
    const steps: LoopStep[] = [
      { tool: "a", params: {} },
      { tool: "b", params: {} },
      { tool: "c", params: {} },
    ];

    const result = await loop(session, { steps, abortOnError: false });

    expect(calls.map((c) => c.tool)).toEqual(["a", "b", "c"]);
    expect(result.success).toBe(false);
    expect(result.completedSteps).toBe(2);
    expect(result.results).toHaveLength(3);
  });

  it("catches a thrown error from execute and surfaces it via onStepError", async () => {
    const onStepError = vi.fn();
    const { session } = recordingSession((tool) => {
      if (tool === "a") throw new Error("network down");
      return ok(tool);
    });
    const steps: LoopStep[] = [{ tool: "a", params: {} }];

    const result = await loop(session, { steps, onStepError });

    expect(result.success).toBe(false);
    expect(onStepError).toHaveBeenCalledWith(steps[0], expect.any(Error), 0);
    expect(onStepError.mock.calls[0]![1].message).toBe("network down");
  });
});

describe("loop() — retry policy", () => {
  it("retries up to maxRetries then succeeds, with linear backoff delays", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    let attempts = 0;
    const { session } = recordingSession((tool) => {
      attempts += 1;
      return attempts < 3 ? fail(tool) : ok(tool);
    });

    const result = await loop(session, {
      steps: [{ tool: "a", params: {} }],
      retryPolicy: { maxRetries: 3, backoff: "linear", baseDelay: 100 },
    });

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
    // delay = baseDelay * (attempt + 1): 100 after attempt 0, 200 after attempt 1
    expect(delays).toEqual([100, 200]);
  });

  it("uses exponential backoff when configured", async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const { session } = recordingSession((tool) => fail(tool));

    const result = await loop(session, {
      steps: [{ tool: "a", params: {} }],
      retryPolicy: { maxRetries: 3, backoff: "exponential", baseDelay: 50 },
    });

    expect(result.success).toBe(false);
    // delay = baseDelay * 2^attempt: 50, 100, 200 across attempts 0..2 (3 retries)
    expect(delays).toEqual([50, 100, 200]);
  });

  it("does not retry when maxRetries is unset (single attempt)", async () => {
    let attempts = 0;
    const { session } = recordingSession((tool) => {
      attempts += 1;
      return fail(tool);
    });

    const result = await loop(session, { steps: [{ tool: "a", params: {} }] });

    expect(attempts).toBe(1);
    expect(result.success).toBe(false);
  });
});

describe("loop() — edge cases (current behavior, see docs/fix-core.md R4)", () => {
  // CHARACTERIZATION OF A SUSPECTED BUG, not an endorsement.
  // results.every() on an empty array is vacuously true, so a run where
  // every step is skipped (or there are no steps) reports success:true
  // with completedSteps:0. Documented in docs/fix-core.md (item R4 / C2
  // pattern). If loop() is later changed to treat "nothing ran" as a
  // non-success, update these expectations deliberately.
  it("reports success:true with zero steps (vacuous truth)", async () => {
    const { session } = recordingSession((tool) => ok(tool));

    const result = await loop(session, { steps: [] });

    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(0);
    expect(result.totalSteps).toBe(0);
  });

  it("reports success:true when every step is skipped by when() (vacuous truth)", async () => {
    const { session, calls } = recordingSession((tool) => ok(tool));
    const steps: LoopStep[] = [
      { tool: "a", params: {}, when: () => false },
      { tool: "b", params: {}, when: () => false },
    ];

    const result = await loop(session, { steps });

    expect(calls).toHaveLength(0);
    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(0);
    expect(result.totalSteps).toBe(2);
  });
});
