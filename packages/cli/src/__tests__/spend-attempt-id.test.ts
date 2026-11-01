/**
 * `codespar spend` names its `attempt_id` on every call (enterprise #2378, B1
 * of the pilot review). A Live project refuses a spend without one, and
 * without one a retry after a lost answer was a second payment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spendCommand } from "../commands/spend.js";

afterEach(() => vi.restoreAllMocks());

function watch() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return bodies;
}

const base = {
  mandate: "cm_1",
  payee: "pix@example.com",
  amount: "100",
  agent: "agt_1",
  apiKey: "csk_test_x",
  baseUrl: "https://api.test.dev",
  json: true,
};

describe("codespar spend attempt_id", () => {
  it("sends the --attempt-id it was given, verbatim", async () => {
    const bodies = watch();
    await spendCommand({ ...base, attemptId: "retry-me-1" });
    expect(bodies[0]?.attempt_id).toBe("retry-me-1");
  });

  it("generates one when none is given, a new one per run", async () => {
    const bodies = watch();
    await spendCommand(base);
    await spendCommand(base);
    expect(String(bodies[0]?.attempt_id)).toMatch(/^cli_[0-9a-f-]{36}$/);
    expect(bodies[1]?.attempt_id).not.toBe(bodies[0]?.attempt_id);
  });
});
