import { describe, it, expect, afterEach } from "vitest";
import type { ToolResult } from "../index.js";
import { validateBaseUrl } from "./contract-suite.js";
import {
  META_TOOL_CONTRACTS,
  type ContractedToolName,
  type FieldRule,
  type MetaToolContractDescriptor,
  type WireShape,
} from "../meta-tool-contract.js";

/** Options for {@link runMetaToolConformanceSuite}. */
export interface ConformanceSuiteOptions {
  /** Which contract'd meta-tool to assert conformance for. */
  tool: ContractedToolName;
  /**
   * Server ids to post when opening the session. Defaults to `[]`, matching
   * a self-hosted OSS runtime that accepts an empty server list. A managed
   * backend requires at least one server, so a managed-side consumer MUST
   * pass `[<seeded-server-id>]` here — see {@link runMetaToolConformanceSuite}.
   */
  servers?: string[];
}

/* ── Pure verification core (no backend, no Vitest) ──────────────
 *
 * The kit's pass/fail logic lives in these pure functions so it can be
 * unit-tested against a fake backend without booting a server. The Vitest
 * suite below is a thin wrapper that drives a live backend and asserts the
 * verdicts these functions return.
 * ─────────────────────────────────────────────────────────────── */

/** A single conformance violation: which check failed and why. */
export interface Violation {
  /** A stable code for the kind of violation. */
  code:
    | "wire-shape"
    | "action-state"
    | "error-unregistered"
    | "error-malformed";
  /** Human-readable detail naming the specific field/rule that failed. */
  detail: string;
}

/** True when `value` matches the JSON-value kind `rule.kind` demands. */
export function fieldMatches(rule: FieldRule, value: unknown): boolean {
  switch (rule.kind) {
    case "string":
      return typeof value === "string";
    case "string-enum":
      return (
        typeof value === "string" &&
        (rule.values?.includes(value) ?? false)
      );
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
  }
}

/**
 * Check a wire object against a {@link WireShape}. Returns the violations
 * found (empty array = conforms). A field is checked when it is `required`
 * (the default) or present; absent optional fields are skipped.
 */
export function checkWireShape(
  shape: WireShape,
  obj: unknown,
): Violation[] {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [
      {
        code: "wire-shape",
        detail: `${shape.name}: expected an object, got ${describeType(obj)}`,
      },
    ];
  }
  const record = obj as Record<string, unknown>;
  const violations: Violation[] = [];
  for (const rule of shape.fields) {
    const required = rule.required ?? true;
    const present = rule.name in record && record[rule.name] != null;
    if (!present) {
      if (required) {
        violations.push({
          code: "wire-shape",
          detail: `${shape.name}.${rule.name}: required field is missing`,
        });
      }
      continue;
    }
    if (!fieldMatches(rule, record[rule.name])) {
      violations.push({
        code: "wire-shape",
        detail: `${shape.name}.${rule.name}: expected ${describeRule(rule)}, got ${describeType(record[rule.name])}`,
      });
    }
  }
  return violations;
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeRule(rule: FieldRule): string {
  if (rule.kind === "string-enum") {
    return `one of [${(rule.values ?? []).join(", ")}]`;
  }
  return rule.kind;
}

/**
 * Verify a successful action result: the `ToolResult` reports success and
 * its `data` conforms to the action's result wire shape. Also enforces that
 * a `statusField`, when declared, holds a value the state machine knows —
 * a terminal status or `in_progress`/non-terminal status drawn from the
 * declared enum (the enum check is part of the wire shape).
 */
export function checkActionResult(
  descriptor: MetaToolContractDescriptor,
  action: string,
  result: ToolResult,
): Violation[] {
  const rule = descriptor.stateMachine?.actions.find(
    (a) => a.action === action,
  );
  if (!rule) {
    return [
      {
        code: "action-state",
        detail: `${descriptor.toolName}: action "${action}" is not in the state machine`,
      },
    ];
  }
  if (!result.success) {
    return [
      {
        code: "action-state",
        detail: `${descriptor.toolName}.${action}: expected a success result, got error "${result.error ?? ""}"`,
      },
    ];
  }
  return checkWireShape(rule.result, result.data);
}

/**
 * Verify a single-shot tool's happy-path result: the `ToolResult` reports
 * success and its `data` conforms to the descriptor's `singleShot` result
 * wire shape. This gives a no-state-machine tool (e.g. `codespar_discover`)
 * the same wire-shape teeth the action path has — a wrong-shaped result
 * fails with a precise `[wire-shape]` violation rather than passing on
 * `success: true` alone.
 */
export function checkSingleShotResult(
  descriptor: MetaToolContractDescriptor,
  result: ToolResult,
): Violation[] {
  const rule = descriptor.singleShot;
  if (!rule) {
    return [
      {
        code: "wire-shape",
        detail: `${descriptor.toolName}: no single-shot rule on the descriptor`,
      },
    ];
  }
  if (!result.success) {
    return [
      {
        code: "wire-shape",
        detail: `${descriptor.toolName}: expected a success result, got error "${result.error ?? ""}"`,
      },
    ];
  }
  return checkWireShape(rule.result, result.data);
}

/**
 * Verify the unregistered-tool error rule: a runtime with no registered
 * implementation returns `success: false` with an `error` that starts with
 * the descriptor's `unregisteredErrorPrefix` (never an HTTP-level error and
 * never a success result).
 */
export function checkUnregisteredError(
  descriptor: MetaToolContractDescriptor,
  result: ToolResult,
): Violation[] {
  const prefix = descriptor.errors.unregisteredErrorPrefix;
  if (result.success) {
    return [
      {
        code: "error-unregistered",
        detail: `${descriptor.toolName}: expected an unregistered error, got a success result`,
      },
    ];
  }
  if (!result.error || !result.error.startsWith(prefix)) {
    return [
      {
        code: "error-unregistered",
        detail: `${descriptor.toolName}: expected error starting with "${prefix}", got "${result.error ?? ""}"`,
      },
    ];
  }
  return [];
}

/**
 * Verify the malformed-input error rule: a malformed input yields a typed
 * error envelope (`success: false` with a non-empty `error`) rather than a
 * success result. The error message itself is implementation-defined; only
 * the shape of the failure is contracted.
 */
export function checkMalformedError(
  descriptor: MetaToolContractDescriptor,
  result: ToolResult,
): Violation[] {
  if (result.success) {
    return [
      {
        code: "error-malformed",
        detail: `${descriptor.toolName}: expected a typed error for malformed input, got a success result`,
      },
    ];
  }
  if (!result.error) {
    return [
      {
        code: "error-malformed",
        detail: `${descriptor.toolName}: expected a non-empty error for malformed input`,
      },
    ];
  }
  return [];
}

/* ── Live-backend session plumbing ───────────────────────────────
 *
 * Mirrors the openSession helper in contract-suite.ts: build a minimal
 * session from raw fetch calls so the kit runs against any backend that
 * implements the codespar session API. Only the two methods the kit needs
 * (execute, close) are built — base-URL validation is shared with the
 * session contract suite.
 * ─────────────────────────────────────────────────────────────── */

interface MinimalSession {
  readonly id: string;
  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

async function openSession(
  baseUrl: string,
  apiKey: string,
  servers: string[],
): Promise<MinimalSession> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const res = await fetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ servers, user_id: "conformance-suite" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`session create failed: ${res.status} ${text}`);
  }
  const raw = (await res.json()) as { id: string };

  return {
    get id() {
      return raw.id;
    },
    async execute(
      toolName: string,
      params: Record<string, unknown>,
    ): Promise<ToolResult> {
      const r = await fetch(`${baseUrl}/v1/sessions/${raw.id}/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: toolName, input: params }),
      });
      if (!r.ok) {
        const body = await r.text();
        return {
          success: false,
          data: null,
          error: `${r.status}: ${body}`,
          duration: 0,
          server: "",
          tool: toolName,
        };
      }
      return (await r.json()) as ToolResult;
    },
    async close(): Promise<void> {
      await fetch(`${baseUrl}/v1/sessions/${raw.id}`, {
        method: "DELETE",
        headers,
      });
    },
  };
}

/** Build the action input the kit posts: the action rule's sample input
 *  plus the `action` discriminator. */
function actionInput(action: string, sample: Record<string, unknown>): Record<string, unknown> {
  return { action, ...sample };
}

/**
 * Register the meta-tool conformance test suite against a live backend.
 *
 * Given a base URL and an `apiKey` for a backend that has an implementation
 * of `opts.tool` registered, drives `execute(toolName, ...)` and asserts the
 * tool's contract descriptor: every action's result wire shape, the action
 * state machine (the declared status enum, terminal vs non-terminal), and
 * the two error rules (unregistered → "Tool not registered"; malformed
 * input → typed error envelope).
 *
 * The suite is implementation-agnostic — it tests whatever is registered at
 * `baseUrl`. It validates the baseUrl before issuing any request: only
 * https:// URLs and localhost are accepted, so a misconfigured CI
 * environment fails early rather than leaking the apiKey to an arbitrary
 * host.
 *
 * The unregistered-error leg uses a deliberately unregistered tool name
 * (the contract'd tool name with a `__unregistered_probe` suffix) so it
 * asserts the runtime's fall-through behavior without depending on any
 * tool being absent.
 *
 * Backend prerequisites:
 * - **Route prefix.** The kit drives `POST /v1/sessions`,
 *   `POST /v1/sessions/:id/execute`, and `DELETE /v1/sessions/:id` — the
 *   backend (or test harness) must mount the session routes under the `/v1`
 *   prefix.
 * - **`servers` option.** `opts.servers` defaults to `[]`. A self-hosted
 *   OSS runtime accepts an empty server list on session create, but a
 *   managed backend requires at least one server — so a managed-side
 *   consumer MUST pass `opts.servers: [<seeded-server-id>]` (a server whose
 *   meta-tool implementation is registered), or session create will be
 *   rejected before any conformance case runs.
 *
 * @param baseUrl - API base URL (e.g. "https://your-runtime.example" or "http://localhost:3000")
 * @param apiKey  - Bearer token for session creation
 * @param opts    - The tool to assert and optional servers list (see {@link ConformanceSuiteOptions})
 */
export function runMetaToolConformanceSuite(
  baseUrl: string,
  apiKey: string,
  opts: ConformanceSuiteOptions,
): void {
  validateBaseUrl(baseUrl);

  const descriptor = META_TOOL_CONTRACTS[opts.tool];
  const servers = opts.servers ?? [];

  describe(`meta-tool conformance suite: ${descriptor.toolName}`, () => {
    let session: MinimalSession | null = null;

    afterEach(async () => {
      try {
        if (session) await session.close();
      } finally {
        session = null;
      }
    });

    if (descriptor.stateMachine) {
      for (const action of descriptor.stateMachine.actions) {
        it(`${descriptor.toolName} action "${action.action}" returns a conforming ${action.result.name}`, async () => {
          session = await openSession(baseUrl, apiKey, servers);
          const result = await session.execute(
            descriptor.toolName,
            actionInput(action.action, action.sampleInput),
          );
          const violations = checkActionResult(
            descriptor,
            action.action,
            result,
          );
          expect(violations, formatViolations(violations)).toEqual([]);
        });
      }
    } else if (descriptor.singleShot) {
      const singleShot = descriptor.singleShot;
      it(`${descriptor.toolName} returns a conforming ${singleShot.result.name}`, async () => {
        session = await openSession(baseUrl, apiKey, servers);
        const result = await session.execute(
          descriptor.toolName,
          singleShot.sampleInput,
        );
        const violations = checkSingleShotResult(descriptor, result);
        expect(violations, formatViolations(violations)).toEqual([]);
      });
    }

    it(`${descriptor.toolName} returns "${descriptor.errors.unregisteredErrorPrefix}" for an unregistered name`, async () => {
      session = await openSession(baseUrl, apiKey, servers);
      const result = await session.execute(
        `${descriptor.toolName}__unregistered_probe`,
        {},
      );
      const violations = checkUnregisteredError(descriptor, result);
      expect(violations, formatViolations(violations)).toEqual([]);
    });

    it(`${descriptor.toolName} returns a typed error for malformed input`, async () => {
      session = await openSession(baseUrl, apiKey, servers);
      const malformed = descriptor.errors.malformedAction
        ? actionInput(
            descriptor.errors.malformedAction,
            descriptor.errors.malformedInput,
          )
        : descriptor.errors.malformedInput;
      const result = await session.execute(descriptor.toolName, malformed);
      const violations = checkMalformedError(descriptor, result);
      expect(violations, formatViolations(violations)).toEqual([]);
    });
  });
}

/** Join violations into a single message for an assertion failure. */
export function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return "no violations";
  return violations.map((v) => `[${v.code}] ${v.detail}`).join("; ");
}
