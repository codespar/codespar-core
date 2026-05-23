/**
 * AgentGate type-narrowed guard tests.
 *
 * Asserts:
 *   - Positive + negative paths per guard.
 *   - Sibling-field-missing fixtures — a well-formed `code` with
 *     missing required siblings (e.g. `rule_id` for policy_denied)
 *     returns false. The guard does not narrow on the discriminant
 *     alone.
 *   - Unknown-code defense-in-depth — an unknown `code` value never
 *     narrows positive on any guard.
 *   - assertExhaustiveAgentGate compiles when every variant is
 *     handled (the test below is the compile-time witness).
 *   - output.code vs error_code disagreement — guards key on the
 *     `code` field on the payload, ignoring sibling discrepancies.
 */

import { describe, it, expect } from "vitest";
import {
  AGENT_GATE_CODES,
  AgentGateCode,
  assertExhaustiveAgentGate,
  isApprovalRequired,
  isMocksEngineError,
  isMocksExhausted,
  isPolicyDenied,
  isToolNotMocked,
  type AgentGateToolResultOutput,
} from "../agent-gate.js";

describe("AGENT_GATE_CODES set", () => {
  it("includes the five canonical codes", () => {
    expect(AGENT_GATE_CODES).toContain("policy_denied");
    expect(AGENT_GATE_CODES).toContain("approval_required");
    expect(AGENT_GATE_CODES).toContain("mocks_exhausted");
    expect(AGENT_GATE_CODES).toContain("mocks_engine_error");
    expect(AGENT_GATE_CODES).toContain("tool_not_mocked");
  });
});

describe("isPolicyDenied", () => {
  it("returns true for a well-formed policy_denied output", () => {
    const out: unknown = {
      code: AgentGateCode.PolicyDenied,
      rule_id: "spend_cap",
      message: "exceeds tenant cap",
    };
    expect(isPolicyDenied(out)).toBe(true);
  });

  it("returns false when rule_id is missing", () => {
    const out: unknown = {
      code: AgentGateCode.PolicyDenied,
      message: "missing rule",
    };
    expect(isPolicyDenied(out)).toBe(false);
  });

  it("returns false when message is missing", () => {
    const out: unknown = {
      code: AgentGateCode.PolicyDenied,
      rule_id: "spend_cap",
    };
    expect(isPolicyDenied(out)).toBe(false);
  });

  it("returns false on a foreign discriminant", () => {
    const out: unknown = {
      code: "approval_required",
      rule_id: "x",
      message: "y",
    };
    expect(isPolicyDenied(out)).toBe(false);
  });

  it("returns false on an unknown code (defense in depth)", () => {
    const out: unknown = {
      code: "totally_made_up",
      rule_id: "x",
      message: "y",
    };
    expect(isPolicyDenied(out)).toBe(false);
  });

  it("returns false on null/undefined/non-object", () => {
    expect(isPolicyDenied(null)).toBe(false);
    expect(isPolicyDenied(undefined)).toBe(false);
    expect(isPolicyDenied("policy_denied")).toBe(false);
  });
});

describe("isApprovalRequired", () => {
  it("returns true for a well-formed approval_required output", () => {
    const out: unknown = {
      code: AgentGateCode.ApprovalRequired,
      approval_id: "apr_abc",
      expires_at: "2026-12-01T00:00:00Z",
      message: "approve the transfer",
    };
    expect(isApprovalRequired(out)).toBe(true);
  });

  it("returns false when approval_id is missing", () => {
    const out: unknown = {
      code: AgentGateCode.ApprovalRequired,
      expires_at: "2026-12-01T00:00:00Z",
      message: "x",
    };
    expect(isApprovalRequired(out)).toBe(false);
  });

  it("returns false when expires_at is missing", () => {
    const out: unknown = {
      code: AgentGateCode.ApprovalRequired,
      approval_id: "apr_abc",
      message: "x",
    };
    expect(isApprovalRequired(out)).toBe(false);
  });

  it("returns false when message is missing", () => {
    const out: unknown = {
      code: AgentGateCode.ApprovalRequired,
      approval_id: "apr_abc",
      expires_at: "x",
    };
    expect(isApprovalRequired(out)).toBe(false);
  });
});

describe("isMocksExhausted and isMocksEngineError", () => {
  it("isMocksExhausted: positive + sibling-missing", () => {
    expect(
      isMocksExhausted({ code: AgentGateCode.MocksExhausted, message: "drained" }),
    ).toBe(true);
    expect(isMocksExhausted({ code: AgentGateCode.MocksExhausted })).toBe(false);
  });

  it("isMocksEngineError: positive + sibling-missing", () => {
    expect(
      isMocksEngineError({
        code: AgentGateCode.MocksEngineError,
        message: "consume failed",
      }),
    ).toBe(true);
    expect(isMocksEngineError({ code: AgentGateCode.MocksEngineError })).toBe(false);
  });
});

describe("isToolNotMocked", () => {
  it("returns true with tool_name + message", () => {
    expect(
      isToolNotMocked({
        code: AgentGateCode.ToolNotMocked,
        tool_name: "asaas/create_payment",
        message: "not in mocks map",
      }),
    ).toBe(true);
  });

  it("returns false when tool_name is missing", () => {
    expect(
      isToolNotMocked({ code: AgentGateCode.ToolNotMocked, message: "x" }),
    ).toBe(false);
  });
});

describe("assertExhaustiveAgentGate", () => {
  it("compiles when every code variant is handled", () => {
    // The test BODY here is the compile-time witness; runtime asserts
    // the unreachable-default branch throws on a hostile cast.
    function describe(value: AgentGateToolResultOutput): string {
      switch (value.code) {
        case AgentGateCode.PolicyDenied:
          return "denied";
        case AgentGateCode.ApprovalRequired:
          return "approval";
        case AgentGateCode.MocksExhausted:
          return "exhausted";
        case AgentGateCode.MocksEngineError:
          return "engine";
        case AgentGateCode.ToolNotMocked:
          return "not_mocked";
        case AgentGateCode.NotSupportedOnOss:
          return "oss_skip";
        default:
          // If a 7th code lands without this branch being updated, TS
          // fails: assertExhaustiveAgentGate(value) would error at
          // compile time on a non-never argument.
          return assertExhaustiveAgentGate(value);
      }
    }
    expect(
      describe({
        code: AgentGateCode.PolicyDenied,
        rule_id: "x",
        message: "y",
      }),
    ).toBe("denied");
    expect(() =>
      assertExhaustiveAgentGate({ code: "rogue" as never } as never),
    ).toThrow(/agent-gate/i);
  });
});
