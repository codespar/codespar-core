/**
 * The createSession body builder's `agentId` forwarding (enterprise 0274,
 * codespar-enterprise#1688).
 *
 *   - Wire-neutrality: without `agentId` the body is byte-identical to before.
 *   - With it, the handle goes out as `agent_id`, separate from `user_id`.
 *   - api-types accepts the body the API accepts: `agent_id`, and an empty
 *     `servers` list, which the old `.min(1)` refused.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CreateSessionRequestSchema } from "@codespar/api-types";
import { CodeSpar } from "../index.js";

function sessionResponse() {
  return {
    ok: true,
    status: 201,
    text: async () => "",
    json: async () => ({
      id: "ses_demo",
      org_id: "org_demo",
      user_id: "user_demo",
      servers: ["asaas"],
      status: "active" as const,
      created_at: new Date().toISOString(),
      closed_at: null,
    }),
  };
}

async function bodyOf(config: Parameters<CodeSpar["create"]>[1]): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn().mockResolvedValueOnce(sessionResponse());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const cs = new CodeSpar({ apiKey: "csk_live_test", baseUrl: "https://api.example.com" });
  await cs.create("user_demo", config);
  const init = fetchMock.mock.calls[0]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("createSession body builder forwards agentId", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits agent_id when agentId is not set (wire-neutral)", async () => {
    const body = await bodyOf({ servers: ["asaas"] });
    expect("agent_id" in body).toBe(false);
    expect(body).toEqual({ servers: ["asaas"], user_id: "user_demo" });
  });

  it("forwards agentId as agent_id, beside an unchanged user_id", async () => {
    const body = await bodyOf({ servers: ["asaas"], agentId: "ag_curb" });
    expect(body).toEqual({ servers: ["asaas"], user_id: "user_demo", agent_id: "ag_curb" });
  });
});

describe("CreateSessionRequestSchema matches what the API accepts", () => {
  it("accepts agent_id", () => {
    expect(CreateSessionRequestSchema.safeParse({ servers: ["asaas"], agent_id: "ag_curb" }).success).toBe(true);
  });

  it("accepts an empty servers list, as the API does", () => {
    expect(CreateSessionRequestSchema.safeParse({ servers: [] }).success).toBe(true);
  });

  it("still refuses more than 20 servers and an empty agent_id", () => {
    const many = Array.from({ length: 21 }, (_, i) => `s${i}`);
    expect(CreateSessionRequestSchema.safeParse({ servers: many }).success).toBe(false);
    expect(CreateSessionRequestSchema.safeParse({ servers: [], agent_id: "" }).success).toBe(false);
  });
});
