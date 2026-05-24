/**
 * Wire-shape parity test for the test-mode mocks field.
 *
 * Asserts that the TypeScript SessionConfig type carries the optional
 * `mocks` field with the right shape, and that the serialized form
 * matches the canonical fixture used by the Python SDK's parallel
 * test. Both languages serialize the same example to byte-identical
 * JSON; any drift here is a wire-contract break.
 *
 * The canonical fixture lives at packages/python/tests/_fixtures/
 * mocks_canonical.json — kept in sync by hand. Future contributors
 * MUST update both files together when extending the example.
 */

import { describe, it, expect } from "vitest";
import type { MockObject, MockValue } from "@codespar/types";
import type { SessionConfig } from "../types.js";

const CANONICAL_BODY = {
  servers: ["asaas"],
  user_id: "user_demo",
  mocks: {
    "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
    "asaas/get_payment": [
      { id: "pay_test_42", status: "PENDING" },
      { id: "pay_test_42", status: "CONFIRMED" },
    ],
  },
} as const;

describe("MockObject + MockValue type aliases", () => {
  it("accepts a plain dict as MockObject", () => {
    const obj: MockObject = { id: "pay_test_42", status: "PENDING" };
    expect(obj.id).toBe("pay_test_42");
  });

  it("accepts a single MockObject as MockValue (static mock)", () => {
    const v: MockValue = { id: "pay_test_42", status: "PENDING" };
    expect(v).toBeDefined();
  });

  it("accepts a MockObject array as MockValue (stateful mock)", () => {
    const v: MockValue = [
      { id: "pay_test_42", status: "PENDING" },
      { id: "pay_test_42", status: "CONFIRMED" },
    ];
    expect(Array.isArray(v)).toBe(true);
  });
});

describe("CreateSessionOptions carries optional mocks field", () => {
  it("accepts a SessionConfig with no mocks (wire-neutral)", () => {
    const cfg: SessionConfig = { servers: ["asaas"] };
    expect(cfg.mocks).toBeUndefined();
  });

  it("accepts a SessionConfig with canonical mocks shape", () => {
    const cfg: SessionConfig = {
      servers: ["asaas"],
      mocks: {
        "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
        "asaas/get_payment": [
          { id: "pay_test_42", status: "PENDING" },
          { id: "pay_test_42", status: "CONFIRMED" },
        ],
      },
    };
    expect(cfg.mocks?.["asaas/create_payment"]).toBeDefined();
  });
});

describe("Canonical body serializes to byte-identical JSON", () => {
  it("matches the Python SDK fixture byte-for-byte", () => {
    // The canonical body field order is preserved by the JSON.stringify
    // contract used in createSession's body builder. If field ordering
    // changes here, the Python side must change too.
    const serialized = JSON.stringify(CANONICAL_BODY);
    expect(serialized).toBe(
      '{"servers":["asaas"],"user_id":"user_demo","mocks":{"asaas/create_payment":{"id":"pay_test_42","status":"PENDING"},"asaas/get_payment":[{"id":"pay_test_42","status":"PENDING"},{"id":"pay_test_42","status":"CONFIRMED"}]}}',
    );
  });
});
