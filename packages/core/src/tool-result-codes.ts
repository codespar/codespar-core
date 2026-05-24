/**
 * Tool-result code helpers — type-narrowed guards for the discriminated
 * `tool_result.output` union surfaced on streamed `ToolCallRecord`
 * values.
 *
 * The five variants are inert wire shapes — they only describe what the
 * backend may stamp on `tool_result.output`. The guards turn `unknown`
 * into one of the five `*Output` interfaces so callers can branch
 * without casting.
 *
 * Each guard checks both the `code` discriminant against
 * TOOL_RESULT_CODES AND its own required sibling fields — so a
 * well-formed `code` with a missing sibling returns false rather
 * than narrowing positive on the discriminant alone. The exhaustive-
 * match utility (`assertExhaustiveToolResult`) makes a switch over
 * ToolResultCode fail to compile if a sixth variant lands without
 * the consumer updating their handler.
 */

import type { ToolCallRecord } from "@codespar/types";

export const ToolResultCode = {
  PolicyDenied: "policy_denied",
  ApprovalRequired: "approval_required",
  MocksExhausted: "mocks_exhausted",
  MocksEngineError: "mocks_engine_error",
  ToolNotMocked: "tool_not_mocked",
} as const;

export type ToolResultCode = (typeof ToolResultCode)[keyof typeof ToolResultCode];

export const TOOL_RESULT_CODES: ReadonlySet<ToolResultCode> = new Set([
  ToolResultCode.PolicyDenied,
  ToolResultCode.ApprovalRequired,
  ToolResultCode.MocksExhausted,
  ToolResultCode.MocksEngineError,
  ToolResultCode.ToolNotMocked,
]);

export interface PolicyDeniedOutput {
  code: typeof ToolResultCode.PolicyDenied;
  rule_id: string;
  message: string;
}

export interface ApprovalRequiredOutput {
  code: typeof ToolResultCode.ApprovalRequired;
  approval_id: string;
  expires_at: string;
  message: string;
}

export interface MocksExhaustedOutput {
  code: typeof ToolResultCode.MocksExhausted;
  message: string;
}

export interface MocksEngineErrorOutput {
  code: typeof ToolResultCode.MocksEngineError;
  message: string;
}

export interface ToolNotMockedOutput {
  code: typeof ToolResultCode.ToolNotMocked;
  tool_name: string;
  message: string;
}

export type ToolResultOutcome =
  | PolicyDeniedOutput
  | ApprovalRequiredOutput
  | MocksExhaustedOutput
  | MocksEngineErrorOutput
  | ToolNotMockedOutput;

// Narrowed ToolCallRecord aliases — when a guard succeeds the
// `output` field is known to be the corresponding *Output variant.
export type PolicyDeniedToolCall = ToolCallRecord & {
  output: PolicyDeniedOutput;
};
export type ApprovalRequiredToolCall = ToolCallRecord & {
  output: ApprovalRequiredOutput;
};
export type MocksExhaustedToolCall = ToolCallRecord & {
  output: MocksExhaustedOutput;
};
export type MocksEngineErrorToolCall = ToolCallRecord & {
  output: MocksEngineErrorOutput;
};
export type ToolNotMockedToolCall = ToolCallRecord & {
  output: ToolNotMockedOutput;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

export function isPolicyDenied(value: unknown): value is PolicyDeniedOutput {
  if (!isObject(value)) return false;
  if (value.code !== ToolResultCode.PolicyDenied) return false;
  if (!TOOL_RESULT_CODES.has(value.code as ToolResultCode)) return false;
  return readStringField(value, "rule_id") !== null
    && readStringField(value, "message") !== null;
}

export function isApprovalRequired(value: unknown): value is ApprovalRequiredOutput {
  if (!isObject(value)) return false;
  if (value.code !== ToolResultCode.ApprovalRequired) return false;
  if (!TOOL_RESULT_CODES.has(value.code as ToolResultCode)) return false;
  return readStringField(value, "approval_id") !== null
    && readStringField(value, "expires_at") !== null
    && readStringField(value, "message") !== null;
}

export function isMocksExhausted(value: unknown): value is MocksExhaustedOutput {
  if (!isObject(value)) return false;
  if (value.code !== ToolResultCode.MocksExhausted) return false;
  if (!TOOL_RESULT_CODES.has(value.code as ToolResultCode)) return false;
  return readStringField(value, "message") !== null;
}

export function isMocksEngineError(value: unknown): value is MocksEngineErrorOutput {
  if (!isObject(value)) return false;
  if (value.code !== ToolResultCode.MocksEngineError) return false;
  if (!TOOL_RESULT_CODES.has(value.code as ToolResultCode)) return false;
  return readStringField(value, "message") !== null;
}

export function isToolNotMocked(value: unknown): value is ToolNotMockedOutput {
  if (!isObject(value)) return false;
  if (value.code !== ToolResultCode.ToolNotMocked) return false;
  if (!TOOL_RESULT_CODES.has(value.code as ToolResultCode)) return false;
  return readStringField(value, "tool_name") !== null
    && readStringField(value, "message") !== null;
}

/**
 * Exhaustive-match witness. A `switch` over `ToolResultCode` should
 * pass `value` here in the default branch — TS fails to compile if
 * `value` isn't narrowed to `never`, i.e. if a code variant escaped
 * the switch. The runtime body throws so a hostile cast at runtime
 * doesn't silently swallow an unknown code.
 */
export function assertExhaustiveToolResult(value: never): never {
  throw new Error(
    `tool-result-codes: unexpected output variant ${JSON.stringify(value)}`,
  );
}
