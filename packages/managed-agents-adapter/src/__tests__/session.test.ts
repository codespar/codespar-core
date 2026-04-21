import { describe, it, expect, vi, afterEach } from "vitest";
import { createManagedAgentsSession } from "../session.js";
import type { AgentRuntime, AgentEvent, PolicyHook } from "../session.js";
import {
  InvalidToolNameError,
  PolicyViolationError,
  ApprovalRequiredError,
  ConcurrentOperationError,
  DrainTimeoutError,
} from "../errors.js";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    createSession: vi.fn().mockResolvedValue("session-1"),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "done", result: { message: "ok", tool_calls: [], iterations: 1 } };
    }),
    getStatus: vi.fn().mockResolvedValue({ state: "active" }),
    ...overrides,
  };
}

function runtimeWithToolResult(data: unknown = { output: "result" }): AgentRuntime {
  return makeRuntime({
    streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "tool_result",
        success: true,
        data,
        error: null,
        duration: 5,
        server: "test-server",
      };
    }),
  });
}

async function openSession(runtime: AgentRuntime, options: Record<string, unknown> = {}) {
  return createManagedAgentsSession(
    runtime,
    { agentId: "agent-1", environmentId: "env-1" },
    options,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("tool name injection guard", () => {
  it.each(["my_tool", "my-tool", "Tool123", "a", "A1-b_C"])(
    "accepts valid tool name %s",
    async (name) => {
      const session = await openSession(runtimeWithToolResult());
      await expect(session.execute(name, {})).resolves.toBeDefined();
    },
  );

  it.each([
    "tool name",
    "tool.name",
    "tool/name",
    "tool\nname",
    "tool\x00name",
    "",
    "tool name with spaces",
  ])("rejects invalid tool name %j with InvalidToolNameError", async (name) => {
    const session = await openSession(makeRuntime());
    await expect(session.execute(name, {})).rejects.toBeInstanceOf(InvalidToolNameError);
  });

  it("includes the offending name in the error", async () => {
    const session = await openSession(makeRuntime());
    const err = await session.execute("bad name", {}).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidToolNameError);
    expect((err as InvalidToolNameError).toolName).toBe("bad name");
  });
});

describe("policy hook", () => {
  it("throws PolicyViolationError when policy returns allowed: false", async () => {
    const policyHook: PolicyHook = {
      evaluate: vi.fn().mockResolvedValue({ allowed: false }),
    };
    const session = await openSession(makeRuntime(), { policyHook });
    await expect(session.execute("tool", {})).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it("throws ApprovalRequiredError when policy returns requiresApproval: true", async () => {
    const policyHook: PolicyHook = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: true }),
    };
    const session = await openSession(makeRuntime(), { policyHook });
    await expect(session.execute("tool", {})).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("evaluates policyHook before sanitizeParams", async () => {
    const callOrder: string[] = [];
    const policyHook: PolicyHook = {
      evaluate: vi.fn().mockImplementation(async () => {
        callOrder.push("policy");
        return { allowed: true };
      }),
    };
    const sanitizeParams = vi.fn().mockImplementation((p: Record<string, unknown>) => {
      callOrder.push("sanitize");
      return p;
    });
    const session = await openSession(runtimeWithToolResult(), { policyHook, sanitizeParams });
    await session.execute("tool", { amount: 100 });
    expect(callOrder).toEqual(["policy", "sanitize"]);
  });

  it("sends sanitized params, not original params, to the runtime", async () => {
    const policyHook: PolicyHook = {
      evaluate: vi.fn().mockResolvedValue({ allowed: true }),
    };
    const sanitizeParams = vi.fn().mockReturnValue({ sanitized: true });
    const runtime = runtimeWithToolResult();
    const session = await openSession(runtime, { policyHook, sanitizeParams });
    await session.execute("tool", { raw: true });
    const sent = JSON.parse((runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][1]);
    expect(sent.input).toEqual({ sanitized: true });
  });
});

describe("mutex — concurrent operation guard", () => {
  it("throws ConcurrentOperationError when execute is called while another is in progress", async () => {
    let resolveStream!: () => void;
    const held = new Promise<void>((r) => {
      resolveStream = r;
    });

    const runtime = makeRuntime({
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        await held;
        yield {
          type: "tool_result",
          success: true,
          data: null,
          error: null,
          duration: 0,
          server: "",
        };
      }),
    });

    const session = await openSession(runtime);
    const first = session.execute("tool", {});
    await expect(session.execute("tool", {})).rejects.toBeInstanceOf(ConcurrentOperationError);
    resolveStream();
    await first;
  });

  it("releases mutex after execute throws, allowing the next call through", async () => {
    const runtime = makeRuntime({
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValue(undefined),
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        yield {
          type: "tool_result",
          success: true,
          data: null,
          error: null,
          duration: 0,
          server: "",
        };
      }),
    });

    const session = await openSession(runtime);
    await expect(session.execute("tool", {})).rejects.toThrow("network error");
    await expect(session.execute("tool", {})).resolves.toBeDefined();
  });

  it("releases mutex after send throws", async () => {
    const runtime = makeRuntime({
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("send failed"))
        .mockResolvedValue(undefined),
    });

    const session = await openSession(runtime);
    await expect(session.send("hello")).rejects.toThrow("send failed");
    await expect(session.send("hello")).resolves.toBeDefined();
  });

  it("releases mutex after sendStream throws", async () => {
    const runtime = makeRuntime({
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new Error("stream failed"))
        .mockResolvedValue(undefined),
    });

    const session = await openSession(runtime);
    const iter = session.sendStream("hello")[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow("stream failed");
    await expect(session.send("hello")).resolves.toBeDefined();
  });
});

describe("DrainTimeoutError", () => {
  it("throws DrainTimeoutError when event stream does not yield tool_result within deadline", async () => {
    vi.useFakeTimers();

    const runtime = makeRuntime({
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        vi.advanceTimersByTime(200);
        yield { type: "assistant_text", content: "thinking...", iteration: 0 };
        // deadline exceeded — next check inside _drainForToolResult throws
      }),
    });

    const session = await openSession(runtime, { drainTimeoutMs: 100 });
    await expect(session.execute("tool", {})).rejects.toBeInstanceOf(DrainTimeoutError);
  });

  it("DrainTimeoutError carries the configured timeout value", async () => {
    vi.useFakeTimers();

    const runtime = makeRuntime({
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        vi.advanceTimersByTime(200);
        yield { type: "assistant_text", content: "...", iteration: 0 };
      }),
    });

    const session = await openSession(runtime, { drainTimeoutMs: 50 });
    const err = await session.execute("tool", {}).catch((e) => e);
    expect(err).toBeInstanceOf(DrainTimeoutError);
    expect((err as DrainTimeoutError).timeoutMs).toBe(50);
  });
});

describe("execute()", () => {
  it("returns a ToolResult with the expected shape", async () => {
    const session = await openSession(runtimeWithToolResult({ value: 42 }));
    const result = await session.execute("my_tool", { x: 1 });
    expect(result).toMatchObject({
      success: true,
      data: { value: 42 },
      tool: "my_tool",
    });
  });

  it("sends tool name and params as JSON to the runtime", async () => {
    const runtime = runtimeWithToolResult();
    const session = await openSession(runtime);
    await session.execute("do_thing", { key: "val" });
    const [, body] = (runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(body)).toEqual({ tool: "do_thing", input: { key: "val" } });
  });
});

describe("send()", () => {
  it("returns a SendResult with message, tool_calls, and iterations", async () => {
    const session = await openSession(makeRuntime());
    const result = await session.send("hello");
    expect(result).toMatchObject({
      message: "ok",
      tool_calls: [],
      iterations: 1,
    });
  });
});

describe("sendStream()", () => {
  it("yields typed StreamEvents and stops at done", async () => {
    const runtime = makeRuntime({
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "assistant_text", content: "hi", iteration: 0 };
        yield { type: "done", result: { message: "done", tool_calls: [], iterations: 1 } };
      }),
    });
    const session = await openSession(runtime);
    const events = [];
    for await (const ev of session.sendStream("hello")) {
      events.push(ev);
    }
    expect(events[0]).toMatchObject({ type: "assistant_text", content: "hi" });
    expect(events[1]).toMatchObject({ type: "done" });
    expect(events).toHaveLength(2);
  });

  it("skips events with unknown types", async () => {
    const runtime = makeRuntime({
      streamEvents: vi.fn().mockImplementation(async function* (): AsyncGenerator<AgentEvent> {
        yield { type: "unknown_internal_event" };
        yield { type: "done", result: { message: "", tool_calls: [], iterations: 0 } };
      }),
    });
    const session = await openSession(runtime);
    const events = [];
    for await (const ev of session.sendStream("hi")) {
      events.push(ev);
    }
    // only the "done" event should be present; the unknown type was dropped
    expect(events.map((e) => e.type)).toEqual(["done"]);
  });
});

describe("connections()", () => {
  it("returns connected: true when runtime state is active", async () => {
    const session = await openSession(makeRuntime({ getStatus: vi.fn().mockResolvedValue({ state: "active" }) }));
    const conns = await session.connections();
    expect(conns[0]).toMatchObject({ connected: true });
  });

  it("returns connected: false when runtime state is not active", async () => {
    const session = await openSession(makeRuntime({ getStatus: vi.fn().mockResolvedValue({ state: "idle" }) }));
    const conns = await session.connections();
    expect(conns[0]).toMatchObject({ connected: false });
  });
});

describe("close()", () => {
  it("transitions status to closed", async () => {
    const session = await openSession(makeRuntime());
    expect(session.status).toBe("active");
    await session.close();
    expect(session.status).toBe("closed");
  });
});
