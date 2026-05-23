/**
 * Tests for the createSession body builder's `mocks` forwarding.
 *
 * Asserts:
 *   - Wire-neutrality: a cs.create without `mocks` produces a body
 *     byte-identical to today's shape (R18).
 *   - Forwarded shape: a cs.create with `mocks` includes the field
 *     verbatim — no SDK-side rewriting of canonical names.
 *   - Empty `mocks: {}` is forwarded (the backend accepts; strict-
 *     mode R3a activates only on non-empty maps).
 *   - Double-underscore key form reaches the backend unrewritten
 *     so the canonical-form rejection surfaces at the right layer.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CodeSpar } from "../index.js";

function mockSessionResponse() {
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

describe("createSession body builder forwards mocks", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("omits mocks key from the wire body when undefined (R18 wire-neutral)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSessionResponse()) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    await cs.create("user_demo", { servers: ["asaas"] });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect("mocks" in body).toBe(false);
    expect(body).toEqual({ servers: ["asaas"], user_id: "user_demo" });
  });

  it("forwards mocks verbatim when present", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSessionResponse()) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    await cs.create("user_demo", {
      servers: ["asaas"],
      mocks: {
        "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
      },
    });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.mocks).toEqual({
      "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
    });
  });

  it("accepts and forwards an empty mocks={} body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSessionResponse()) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    await cs.create("user_demo", { servers: ["asaas"], mocks: {} });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.mocks).toEqual({});
  });

  it("does NOT rewrite double-underscore keys — they reach the backend verbatim", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSessionResponse()) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    await cs.create("user_demo", {
      servers: ["asaas"],
      mocks: { asaas__create_payment: { id: "pay_test_42" } },
    });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const mocks = body.mocks as Record<string, unknown>;
    expect(Object.keys(mocks)).toEqual(["asaas__create_payment"]);
  });

  it("matches the canonical fixture byte-for-byte when the same input lands", async () => {
    // Same canonical body used by the Python parity test.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockSessionResponse()) as unknown as typeof fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cs = new CodeSpar({
      apiKey: "csk_live_test",
      baseUrl: "https://api.example.com",
    });
    await cs.create("user_demo", {
      servers: ["asaas"],
      mocks: {
        "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
        "asaas/get_payment": [
          { id: "pay_test_42", status: "PENDING" },
          { id: "pay_test_42", status: "CONFIRMED" },
        ],
      },
    });

    const init = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as { body: string };
    expect(init.body).toBe(
      '{"servers":["asaas"],"user_id":"user_demo","mocks":{"asaas/create_payment":{"id":"pay_test_42","status":"PENDING"},"asaas/get_payment":[{"id":"pay_test_42","status":"PENDING"},{"id":"pay_test_42","status":"CONFIRMED"}]}}',
    );
  });
});
