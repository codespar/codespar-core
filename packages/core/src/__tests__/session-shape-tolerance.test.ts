/**
 * A thin 201 does not produce an Invalid Date (oss-sdk#6, SDK half).
 *
 * The MIT runtime's `POST /sessions` returned `{ id, status }` only, and the
 * SDK built its Session straight off that body:
 * `createdAt: new Date(data.created_at)`. `new Date(undefined)` is not an error
 * — it is an Invalid Date that formats as "Invalid Date", compares false to
 * everything, and serialises to null. `userId` and `servers` came back
 * undefined the same way. Nothing threw and nothing logged.
 *
 * The runtime side is fixed in the codespar (OSS) repo; this is the SDK's own
 * floor, so a backend that answers thinly degrades to a value that is TRUE
 * rather than to one that is broken. Nothing is invented here: `userId` and
 * `servers` fall back to what THIS CALL asked for, and `createdAt` to the
 * moment the response was received, which is within the round trip of the real
 * creation time.
 *
 * The control below is the half that matters: when the backend does send the
 * fields, the backend wins. A fallback that quietly overrode the server would
 * be a worse bug than the one being fixed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeSpar } from "../index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respond(payload: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    text: async () => "",
    json: async () => payload,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * The three fields live on the concrete session object but not on the public
 * `Session` interface, so a TypeScript consumer cannot reach them and a
 * JavaScript one can — which is exactly how an Invalid Date sat there
 * unnoticed. The view type is how this test reads what a JS consumer reads.
 */
interface SessionView {
  userId: string;
  servers: string[];
  createdAt: Date;
}

const client = () =>
  new CodeSpar({ apiKey: "csk_live_test", baseUrl: "https://api.example.com" });

async function createView(
  user: string,
  servers: string[],
): Promise<SessionView> {
  const session = await client().create(user, { servers });
  return session as unknown as SessionView;
}

describe("a session built from a thin 201", () => {
  it("has a real createdAt, not an Invalid Date", async () => {
    respond({ id: "ses_thin", status: "active" });
    const before = Date.now();
    const session = await createView("user_demo", ["asaas"]);
    expect(Number.isNaN(session.createdAt.getTime())).toBe(false);
    expect(session.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(session.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("falls back to what this call asked for, not to undefined", async () => {
    respond({ id: "ses_thin", status: "active" });
    const session = await createView("user_demo", ["asaas", "celcoin"]);
    expect(session.userId).toBe("user_demo");
    expect(session.servers).toEqual(["asaas", "celcoin"]);
  });

  it("control: a backend that sends the fields wins", async () => {
    respond({
      id: "ses_full",
      org_id: "org_demo",
      user_id: "user_from_backend",
      servers: ["celcoin"],
      status: "active",
      created_at: "2026-01-02T03:04:05.000Z",
      closed_at: null,
    });
    const session = await createView("user_demo", ["asaas"]);
    expect(session.userId).toBe("user_from_backend");
    expect(session.servers).toEqual(["celcoin"]);
    expect(session.createdAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("control: an unparseable created_at degrades rather than staying Invalid", async () => {
    respond({ id: "ses_bad", status: "active", created_at: "not-a-date" });
    const session = await createView("user_demo", []);
    expect(Number.isNaN(session.createdAt.getTime())).toBe(false);
  });
});
