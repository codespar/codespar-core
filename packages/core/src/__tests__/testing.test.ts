import { describe, it, expect } from "vitest";
import { fakeSession } from "../testing/index.js";

describe("fakeSession — strict mode (default)", () => {
  it("throws verbatim 'fakeSession: no response registered for tool <name>' on miss", async () => {
    const session = fakeSession();
    await expect(session.execute("asaas/create_payment", { value: 100 })).rejects.toThrow(
      "fakeSession: no response registered for tool asaas/create_payment",
    );
  });

  it("error message is byte-identical to the contract string", async () => {
    const session = fakeSession();
    let captured: Error | null = null;
    try {
      await session.execute("foo/bar", {});
    } catch (err) {
      captured = err as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured!.message).toBe("fakeSession: no response registered for tool foo/bar");
  });
});

describe("fakeSession — registered responses", () => {
  it("returns the static ToolResult registered for a tool name", async () => {
    const session = fakeSession({
      "asaas/create_customer": {
        success: true,
        data: { id: "cus_test_1", name: "Maria" },
        error: null,
        duration: 0,
        server: "asaas",
        tool: "asaas/create_customer",
      },
    });
    const result = await session.execute("asaas/create_customer", { name: "Maria" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: "cus_test_1", name: "Maria" });
    expect(result.tool).toBe("asaas/create_customer");
  });
});

describe("fakeSession — per-tool function variant", () => {
  it("invokes a sync response function with the call's params and returns its result", async () => {
    const session = fakeSession({
      "asaas/create_customer": (input) => ({
        success: true,
        data: { echoed: input },
        error: null,
        duration: 0,
        server: "asaas",
        tool: "asaas/create_customer",
      }),
    });
    const result = await session.execute("asaas/create_customer", { name: "Joana" });
    expect(result.data).toEqual({ echoed: { name: "Joana" } });
  });

  it("awaits a Promise-returning response function", async () => {
    const session = fakeSession({
      "asaas/create_customer": async (input) => ({
        success: true,
        data: { async_echoed: input },
        error: null,
        duration: 0,
        server: "asaas",
        tool: "asaas/create_customer",
      }),
    });
    const result = await session.execute("asaas/create_customer", { name: "Joana" });
    expect(result.data).toEqual({ async_echoed: { name: "Joana" } });
  });
});

describe("fakeSession — lenient mode", () => {
  it("returns {success:true, data:{}} for unregistered tools when lenient: true", async () => {
    const session = fakeSession({}, { lenient: true });
    const result = await session.execute("asaas/create_payment", { value: 100 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({});
    expect(result.error).toBeNull();
    expect(result.tool).toBe("asaas/create_payment");
  });

  it("does not override a registered failure response in lenient mode", async () => {
    const session = fakeSession(
      {
        "asaas/create_payment": {
          success: false,
          data: null,
          error: "boom",
          duration: 0,
          server: "asaas",
          tool: "asaas/create_payment",
        },
      },
      { lenient: true },
    );
    const result = await session.execute("asaas/create_payment", { value: 100 });
    expect(result.success).toBe(false);
    expect(result.error).toBe("boom");
  });
});
