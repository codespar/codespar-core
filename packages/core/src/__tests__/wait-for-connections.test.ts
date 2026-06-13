import { describe, it, expect, vi, afterEach } from "vitest";
import { CodeSpar } from "../index.js";

/**
 * Regression coverage for the `manageConnections.waitForConnections`
 * gate (docs/fix-core.md C2). The bug: `connections()` swallows a
 * failing/empty response into `[]`, and `[].every(...)` is vacuously
 * true, so the wait loop breaks on the first poll and createSession
 * resolves while *zero* servers are connected — the opposite of what
 * waitForConnections promises.
 */

const SESSION_RESPONSE = {
  ok: true,
  status: 201,
  text: async () => "",
  json: async () => ({
    id: "ses_wfc",
    org_id: "org_t",
    user_id: "u1",
    servers: ["zoop"],
    status: "active",
    created_at: new Date().toISOString(),
    closed_at: null,
  }),
};

function connectionsResponse(servers: Array<{ connected: boolean }>) {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ servers, tools: [] }),
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Advances fake timers until the pending promise settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20 && !done; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }
  return p;
}

describe("createSession — waitForConnections", () => {
  it("does not treat an empty/failed connections response as 'all connected'", async () => {
    vi.useFakeTimers();
    let connCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/connections")) {
        connCalls += 1;
        // Empty servers list — the vacuous-truth trap.
        return connectionsResponse([]) as unknown as Response;
      }
      return SESSION_RESPONSE as unknown as Response;
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://api.example.com" });
    const session = await settle(
      cs.create("u1", {
        servers: ["zoop"],
        manageConnections: { waitForConnections: true, timeout: 5000 },
      }),
    );

    expect(session.id).toBe("ses_wfc");
    // Buggy code breaks on the first poll (connCalls === 1). Correct
    // behavior keeps polling until the timeout elapses.
    expect(connCalls).toBeGreaterThan(1);
  });

  it("resolves as soon as every server reports connected", async () => {
    vi.useFakeTimers();
    let connCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith("/connections")) {
        connCalls += 1;
        const connected = connCalls >= 3;
        return connectionsResponse([{ connected }]) as unknown as Response;
      }
      return SESSION_RESPONSE as unknown as Response;
    }) as unknown as typeof fetch;

    const cs = new CodeSpar({ apiKey: "csk_live_t", baseUrl: "https://api.example.com" });
    const session = await settle(
      cs.create("u1", {
        servers: ["zoop"],
        manageConnections: { waitForConnections: true, timeout: 60000 },
      }),
    );

    expect(session.id).toBe("ses_wfc");
    // Polled until the 3rd response flipped connected:true, then stopped.
    expect(connCalls).toBe(3);
  });
});
