/**
 * Internal-consistency checks over every shipped demo scenario.
 *
 * These run with no live runtime — they catch the authoring bugs that would
 * otherwise only surface when a consumer (an OSS example or a managed
 * integration test) runs the scenario against a real chat loop:
 *
 *   - a fixture emits a tool the scenario never mocks (would be tool_not_mocked),
 *   - a fixture emits a raw `serverId__tool` instead of a meta-tool,
 *   - `expectMetaTools` lists a tool the fixtures never emit (or vice versa),
 *   - a fixture's meta-tool arguments omit a field the published contract
 *     marks required.
 *
 * New scenarios are covered automatically: add them to ALL_SCENARIOS.
 */

import { describe, it, expect } from "vitest";
import type { DemoScenario } from "./demo-scenario.js";
import { SERVICE_INVOICE_SCENARIO } from "./demo-scenarios/service-invoice.js";
import { INSTALLMENT_NEGOTIATION_SCENARIO } from "./demo-scenarios/installment-negotiation.js";
import { PAYMENT_REJECTION_SCENARIO } from "./demo-scenarios/payment-rejection.js";
import { CUSTOMER_DATA_REJECTION_SCENARIO } from "./demo-scenarios/customer-data-rejection.js";
import { MERCHANT_BLOCKED_SCENARIO } from "./demo-scenarios/merchant-blocked.js";
import { SHARED_META_TOOL_DEFINITIONS } from "../meta-tool-definitions.js";
import type { SharedMetaToolDefinition } from "../meta-tool-definitions.js";

const DEFS = SHARED_META_TOOL_DEFINITIONS as Record<string, SharedMetaToolDefinition | undefined>;

const ALL_SCENARIOS: DemoScenario[] = [
  SERVICE_INVOICE_SCENARIO,
  INSTALLMENT_NEGOTIATION_SCENARIO,
  PAYMENT_REJECTION_SCENARIO,
  CUSTOMER_DATA_REJECTION_SCENARIO,
  MERCHANT_BLOCKED_SCENARIO,
];

const META_TOOL_NAME = /^codespar_[a-z_]+$/;

interface FixtureToolCall {
  name: string;
  arguments: Record<string, unknown>;
}
interface Fixture {
  response: { toolCalls?: FixtureToolCall[] };
}

/** Pull every tool call the aimock fixtures emit, across all turns. */
function fixtureToolCalls(scenario: DemoScenario): FixtureToolCall[] {
  const fx = scenario.aimockFixtures as { fixtures?: Fixture[] };
  return (fx.fixtures ?? []).flatMap((f) => f.response.toolCalls ?? []);
}

describe.each(ALL_SCENARIOS)("demo scenario consistency: $name", (scenario) => {
  const emitted = fixtureToolCalls(scenario);
  const emittedNames = new Set(emitted.map((c) => c.name));
  const mockKeys = new Set(Object.keys(scenario.mocks));
  const expected = new Set(scenario.turns.flatMap((t) => [...t.expectMetaTools]));

  it("every fixture tool call is a meta-tool (no raw serverId__tool)", () => {
    for (const name of emittedNames) {
      expect(name).toMatch(META_TOOL_NAME);
      expect(name).not.toContain("__");
    }
  });

  it("every fixture tool call has a mocks entry", () => {
    for (const name of emittedNames) {
      expect(mockKeys, `fixture emits ${name} but it is not mocked`).toContain(name);
    }
  });

  it("expectMetaTools and the fixtures' emitted tools agree", () => {
    for (const name of expected) {
      expect(emittedNames, `expectMetaTools lists ${name} but no fixture emits it`).toContain(name);
      expect(mockKeys, `expectMetaTools lists ${name} but it is not mocked`).toContain(name);
    }
    for (const name of emittedNames) {
      expect(expected, `fixtures emit ${name} but no turn expects it`).toContain(name);
    }
  });

  it("every emitted meta-tool's arguments include the contract's required fields", () => {
    for (const call of emitted) {
      const def = DEFS[call.name];
      expect(def, `no shared definition for ${call.name}`).toBeDefined();
      for (const field of def!.input_schema.required ?? []) {
        expect(
          Object.prototype.hasOwnProperty.call(call.arguments, field),
          `${scenario.name}: ${call.name} arguments missing required field "${field}"`,
        ).toBe(true);
      }
    }
  });
});
