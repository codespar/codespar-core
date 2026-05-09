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
