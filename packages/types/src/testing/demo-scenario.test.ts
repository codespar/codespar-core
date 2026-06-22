import { describe, it, expect } from "vitest";
import {
  assertMetaToolTrace,
  driveDemoScenario,
  type DemoScenario,
} from "./demo-scenario.js";
import { SERVICE_INVOICE_SCENARIO } from "./demo-scenarios/service-invoice.js";
import type { ToolCallRecord } from "../types.js";

function call(tool_name: string, status: "success" | "error" = "success"): ToolCallRecord {
  return {
    id: `tc_${tool_name}`,
    tool_name,
    server_id: "",
    status,
    duration_ms: 1,
    input: {},
    output: {},
    error_code: null,
  };
}

const SCN: DemoScenario = {
  name: "unit",
  servers: ["a"],
  mocks: {},
  turns: [{ message: "hi", expectMetaTools: ["codespar_invoice", "codespar_notify"] }],
  aimockFixtures: {},
};

describe("assertMetaToolTrace", () => {
  it("passes when every call is a successful meta-tool and all expected ones appear", () => {
    expect(() =>
      assertMetaToolTrace([call("codespar_invoice"), call("codespar_notify")], SCN),
    ).not.toThrow();
  });

  it("rejects a raw serverId__tool call", () => {
    expect(() =>
      assertMetaToolTrace([call("nuvem-fiscal__create_nfse")], SCN),
    ).toThrow(/raw tool/);
  });

  it("rejects a non-meta-tool name", () => {
    expect(() => assertMetaToolTrace([call("invoice")], SCN)).toThrow(/not a meta-tool/);
  });

  it("rejects a failed meta-tool call", () => {
    expect(() => assertMetaToolTrace([call("codespar_invoice", "error")], SCN)).toThrow(/failed/);
  });

  it("rejects when an expected meta-tool never appeared", () => {
    expect(() => assertMetaToolTrace([call("codespar_invoice")], SCN)).toThrow(
      /codespar_notify.*never called/,
    );
  });
});

describe("driveDemoScenario", () => {
  it("opens a session with servers+mocks, sends each turn, collects the trace, and closes", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
      if (url.endsWith("/v1/sessions") && init.method === "POST") {
        return new Response(JSON.stringify({ id: "sess_1", status: "active" }), { status: 200 });
      }
      if (url.endsWith("/send")) {
        return new Response(
          JSON.stringify({ message: "ok", iterations: 1, tool_calls: [call("codespar_invoice")] }),
          { status: 200 },
        );
      }
      return new Response("", { status: 200 }); // DELETE close
    }) as unknown as typeof fetch;

    const calls = await driveDemoScenario("http://localhost:3000", SERVICE_INVOICE_SCENARIO, {
      fetchImpl: fakeFetch,
    });

    expect(calls.map((c) => c.tool_name)).toEqual(["codespar_invoice"]);
    // create body carried servers + mocks from the scenario
    const create = seen.find((s) => s.url.endsWith("/v1/sessions"));
    expect((create?.body as { servers: string[] }).servers).toEqual(["nuvem-fiscal", "z-api"]);
    expect((create?.body as { mocks: Record<string, unknown> }).mocks).toHaveProperty("codespar_invoice");
    // session was closed
    expect(seen.some((s) => s.method === "DELETE")).toBe(true);
  });

  it("rejects a non-localhost http base URL (apiKey-leak guard)", async () => {
    await expect(
      driveDemoScenario("http://evil.example", SCN, { fetchImpl: (async () => new Response()) as unknown as typeof fetch }),
    ).rejects.toThrow();
  });
});
