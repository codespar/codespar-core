import { describe, it, expect } from "vitest";
import type { SendResult, ToolCallRecord } from "../types.js";
import { validateBaseUrl } from "./contract-suite.js";

/* ── Dual-runtime demo scenario harness ──────────────────────────
 *
 * A demo scenario is one `session.send()` conversation expressed at the
 * commerce meta-tool abstraction, plus the canned-LLM fixtures that drive it.
 * The same scenario object runs unchanged against both the OSS runtime and a
 * managed runtime: each runtime's harness boots the canned-LLM server with the
 * scenario's `aimockFixtures`, then calls {@link runDemoScenario} with its own
 * base URL. Because both runtimes expose the same meta-tools to the agent, one
 * fixture set drives both — and the assertion is identical: every tool the
 * agent called is a meta-tool (`codespar_*`), never a raw `serverId__tool`.
 * ─────────────────────────────────────────────────────────────── */

/** One conversational turn: a user message and the meta-tools it should drive. */
export interface DemoTurn {
  /** The user message sent via `session.send()`. */
  message: string;
  /** Meta-tool names expected to be called while handling this turn. */
  expectMetaTools: readonly string[];
}

/** A reusable, runtime-agnostic demo scenario. */
export interface DemoScenario {
  /** Scenario label, used in the test name. */
  name: string;
  /** Server ids to open the session with. */
  servers: readonly string[];
  /** Per-tool mock fixtures forwarded to session create (runtime test mode). */
  mocks: Record<string, unknown>;
  /** The conversation turns. */
  turns: readonly DemoTurn[];
  /**
   * The canned-LLM (aimock) fixture set the harness serves at
   * `ANTHROPIC_BASE_URL` while the scenario runs. Opaque to the runner — each
   * runtime's harness writes it out and boots the fixture server with it.
   */
  aimockFixtures: unknown;
}

/** Options for driving a scenario. */
export interface RunDemoScenarioOptions {
  /** Bearer key for session create/send. Defaults to "demo". */
  apiKey?: string;
  /** Override `fetch` (for unit-testing the runner without a live runtime). */
  fetchImpl?: typeof fetch;
}

const META_TOOL_NAME = /^codespar_[a-z_]+$/;

/**
 * Assert a collected tool-call trace stayed at the meta-tool abstraction and
 * covered every meta-tool each turn expected. Pure (no I/O) so it is unit
 * testable directly. Throws an `Error` describing the first violation.
 */
export function assertMetaToolTrace(
  calls: readonly ToolCallRecord[],
  scenario: DemoScenario,
): void {
  for (const call of calls) {
    if (call.tool_name.includes("__")) {
      throw new Error(
        `scenario "${scenario.name}": agent called a raw tool "${call.tool_name}"; demos must call meta-tools`,
      );
    }
    if (!META_TOOL_NAME.test(call.tool_name)) {
      throw new Error(
        `scenario "${scenario.name}": "${call.tool_name}" is not a meta-tool (expected codespar_*)`,
      );
    }
    if (call.status !== "success") {
      throw new Error(
        `scenario "${scenario.name}": meta-tool "${call.tool_name}" failed (status ${call.status})`,
      );
    }
  }
  const seen = calls.map((c) => c.tool_name);
  for (const turn of scenario.turns) {
    for (const expected of turn.expectMetaTools) {
      if (!seen.includes(expected)) {
        throw new Error(
          `scenario "${scenario.name}": expected meta-tool "${expected}" was never called`,
        );
      }
    }
  }
}

/**
 * Drive a scenario against a live runtime at `baseUrl`: open a session with the
 * scenario's servers + mocks, send each turn, and collect the tool-call trace.
 * Returns every `ToolCallRecord` the agent produced across all turns.
 */
export async function driveDemoScenario(
  baseUrl: string,
  scenario: DemoScenario,
  opts: RunDemoScenarioOptions = {},
): Promise<ToolCallRecord[]> {
  validateBaseUrl(baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.apiKey ?? "demo"}`,
  };

  const createRes = await doFetch(`${baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      servers: [...scenario.servers],
      user_id: "demo-scenario",
      mocks: scenario.mocks,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`session create failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { id } = (await createRes.json()) as { id: string };

  const calls: ToolCallRecord[] = [];
  try {
    for (const turn of scenario.turns) {
      const sendRes = await doFetch(`${baseUrl}/v1/sessions/${id}/send`, {
        method: "POST",
        headers: { ...headers, Accept: "application/json" },
        body: JSON.stringify({ message: turn.message }),
      });
      if (!sendRes.ok) {
        throw new Error(`send failed: ${sendRes.status} ${await sendRes.text()}`);
      }
      const result = (await sendRes.json()) as SendResult;
      calls.push(...result.tool_calls);
    }
  } finally {
    await doFetch(`${baseUrl}/v1/sessions/${id}`, { method: "DELETE", headers }).catch(() => {});
  }
  return calls;
}

/**
 * Register a vitest test that runs the scenario against `baseUrl` and asserts
 * the meta-tool trace. Both the OSS example and the managed integration test
 * call this with the same scenario object and their own base URL.
 */
export function runDemoScenario(
  baseUrl: string,
  scenario: DemoScenario,
  opts: RunDemoScenarioOptions = {},
): void {
  describe(`demo scenario: ${scenario.name}`, () => {
    it("runs green at the meta-tool abstraction", async () => {
      const calls = await driveDemoScenario(baseUrl, scenario, opts);
      expect(calls.length).toBeGreaterThan(0);
      assertMetaToolTrace(calls, scenario);
    });
  });
}
