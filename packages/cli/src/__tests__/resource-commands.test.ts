/**
 * The derived resource commands: their names, and the request each one
 * actually makes.
 *
 * The names are a pure function of the operation table, so they are
 * pinned here. A spec refresh that renames an existing command shows up
 * as a diff in this list — which is the point: `codespar sellers status`
 * is in someone's script, and it must not change silently.
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { CodesparApiError } from "@codespar/sdk";
import { derivedSurface, deriveGroup } from "../surface.js";
import { bindPathParams, parseQuery, runResourceCommand } from "../commands/resource.js";

const AUTH = { apiKey: "csk_test_notreal", baseUrl: "https://api.test.dev" };

function commandNamed(group: string, name: string) {
  const derived = derivedSurface().find((g) => g.spec.name === group);
  const command = derived?.commands.find((c) => c.name === name);
  if (!command) throw new Error(`no derived command ${group} ${name}`);
  return command;
}

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input: unknown, init: unknown) => {
    calls.push({ url: String(input), init: init as RequestInit });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const PINNED_COMMANDS = [
  "consumers list → GET /v1/consumers",
  "consumers create → POST /v1/consumers",
  "consumers get → GET /v1/consumers/{id}",
  "consumers update → PATCH /v1/consumers/{id}",
  "consumers list-pix-keys → GET /v1/consumers/{consumerId}/pix-keys",
  "consumers create-pix-keys → POST /v1/consumers/{consumerId}/pix-keys",
  "consumers delete-pix-keys → DELETE /v1/consumers/{consumerId}/pix-keys/{key}",
  "consumers pix-charges → GET /v1/consumers/{consumerId}/pix/charges/{reference}",
  "consumers pix-receivements → GET /v1/consumers/{consumerId}/pix/receivements/{endToEndId}",
  "consumers pix-devolutions → GET /v1/consumers/{consumerId}/pix/devolutions/{devolutionId}",
  "consumers fund → GET /v1/consumers/{consumerId}/fund/{txId}",
  "consumers wallet → GET /v1/consumers/{id}/wallet",
  "consumers list-mandates-card → GET /v1/consumers/mandates/{id}/card",
  "consumers delete-mandates-card → DELETE /v1/consumers/mandates/{id}/card",
  "consumers list-receipts → GET /v1/consumers/{consumerId}/receipts",
  "consumers get-receipts → GET /v1/consumers/receipts/{id}",
  "consumers contact-verifications → POST /v1/consumers/{consumerId}/contact-verifications",
  "consumers contact-verifications-verify → POST /v1/consumers/{consumerId}/contact-verifications/{id}/verify",
  "boletos get-subscriptions → GET /v1/consumers/{consumerId}/dda/subscriptions/{document}",
  "boletos delete-subscriptions → DELETE /v1/consumers/{consumerId}/dda/subscriptions/{document}",
  "boletos list → GET /v1/consumers/{consumerId}/dda/boletos",
  "boletos create-subscriptions → POST /v1/consumers/{consumerId}/dda/subscriptions",
  "sellers create → POST /v1/sellers",
  "sellers get → GET /v1/sellers/{sellerId}",
  "sellers status → GET /v1/sellers/{sellerId}/status",
  "sellers pending-settlement → GET /v1/sellers/{sellerId}/pending-settlement",
  "sellers custody → GET /v1/sellers/{sellerId}/custody",
  "sellers ledger → GET /v1/sellers/{sellerId}/ledger",
  "mcp-servers validate → POST /v1/mcp-servers/validate",
  "mcp-servers list → GET /v1/mcp-servers",
  "mcp-servers create → POST /v1/mcp-servers",
  "mcp-servers get → GET /v1/mcp-servers/{id}",
  "mcp-servers delete → DELETE /v1/mcp-servers/{id}",
  "mcp-servers update → PATCH /v1/mcp-servers/{id}",
  "mcp-servers tools → PATCH /v1/mcp-servers/{id}/tools/{tool}",
  "mcp-servers platform-fees-sweep → POST /v1/mcp-servers/platform-fees/sweep",
  "wallets list → GET /v1/wallets",
  "wallets create → POST /v1/wallets",
  "wallets get → GET /v1/wallets/{id}",
  "wallets list-ledger → GET /v1/wallets/{id}/ledger",
  "wallets create-ledger → POST /v1/wallets/{id}/ledger",
  "wallets list-funding-sources → GET /v1/wallets/{id}/funding-sources",
  "wallets create-funding-sources → POST /v1/wallets/{id}/funding-sources",
  "wallets delete-funding-sources → DELETE /v1/wallets/{id}/funding-sources/{connection_id}/{currency}",
  "wallets execute → POST /v1/wallets/{id}/execute",
  "wallets list-recon-anomalies → GET /v1/wallets/{id}/recon-anomalies",
  "wallets create-recon-anomalies → POST /v1/wallets/{id}/recon-anomalies/{aid}",
  "wallets receive → GET /v1/wallets/{id}/receive",
  "wallets custody → GET /v1/wallets/{id}/custody",
  "wallets transfer → POST /v1/wallets/{id}/transfer",
  "wallets statement-import → POST /v1/wallets/{id}/statement-import",
  "triggers list → GET /v1/triggers",
  "triggers create → POST /v1/triggers",
  "triggers get → GET /v1/triggers/{id}",
  "triggers delete → DELETE /v1/triggers/{id}",
  "triggers rotate-secret → POST /v1/triggers/{id}/rotate-secret",
  "triggers list-deliveries → GET /v1/triggers/{id}/deliveries",
  "triggers get-deliveries → GET /v1/triggers/{id}/deliveries/{delivery_id}",
  "triggers dlq → GET /v1/triggers/{id}/dlq",
  "triggers retry-pending → POST /v1/triggers/retry-pending",
  "triggers deliveries-redeliver → POST /v1/triggers/deliveries/{delivery_id}/redeliver",
];

describe("derived resource commands", () => {
  it("are exactly these, with exactly these requests behind them", () => {
    const actual = derivedSurface().flatMap(({ spec, commands }) =>
      commands.map((c) => `${spec.name} ${c.name} \u2192 ${c.method.toUpperCase()} ${c.path}`),
    );
    expect(actual).toEqual(PINNED_COMMANDS);
  });

  it("names a subcommand after the verb alone when it has no literal suffix", () => {
    expect(commandNamed("wallets", "list").path).toBe("/v1/wallets");
    expect(commandNamed("wallets", "get").params).toEqual(["id"]);
  });

  it("disambiguates a shared suffix with the verb, and leaves a unique one bare", () => {
    expect(commandNamed("triggers", "list-deliveries").path).toBe("/v1/triggers/{id}/deliveries");
    expect(commandNamed("triggers", "get-deliveries").path).toBe(
      "/v1/triggers/{id}/deliveries/{delivery_id}",
    );
    expect(commandNamed("triggers", "dlq").method).toBe("get");
  });

  it("keeps the parameters a nested group's prefix passes over", () => {
    // `boletos` hangs off /v1/consumers/{consumerId}/dda: dropping
    // consumerId would leave a command that cannot name a consumer.
    expect(commandNamed("boletos", "list").params).toEqual(["consumerId"]);
    expect(commandNamed("boletos", "get-subscriptions").params).toEqual([
      "consumerId",
      "document",
    ]);
  });

  it("derives nothing for a prefix the document does not declare", () => {
    const empty = deriveGroup(
      { name: "ghost", prefix: "/v1/ghost", description: "not served" },
      undefined,
      [{ name: "ghost", prefix: "/v1/ghost", description: "not served" }],
    );
    expect(empty.commands).toEqual([]);
  });
});

describe("argument binding", () => {
  it("maps positionals onto path parameters in path order", () => {
    expect(
      bindPathParams({ path: "/v1/a/{x}/b/{y}", params: ["x", "y"] }, ["one", "two"]),
    ).toEqual({ x: "one", y: "two" });
  });

  it("refuses the wrong number of positionals, and an empty one", () => {
    expect(() => bindPathParams({ path: "/v1/a/{x}", params: ["x"] }, [])).toThrow(
      /takes 1 argument/,
    );
    expect(() => bindPathParams({ path: "/v1/a/{x}", params: ["x"] }, [""])).toThrow(
      /must not be empty/,
    );
  });

  it("parses --query pairs and collects repeats", () => {
    expect(parseQuery(["status=active", "tag=a", "tag=b"])).toEqual({
      status: "active",
      tag: ["a", "b"],
    });
    expect(() => parseQuery(["novalue"])).toThrow(/key=value/);
  });
});

describe("dispatch", () => {
  it("sends the operation's method, expanded path, query and auth", async () => {
    const calls = mockFetch(200, { data: [{ id: "slr_0000", status: "approved" }] });
    await runResourceCommand(commandNamed("sellers", "status"), {
      ...AUTH,
      args: ["slr_0000"],
      query: ["expand=ledger"],
      json: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test.dev/v1/sellers/slr_0000/status?expand=ledger");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer csk_test_notreal",
    );
  });

  it("sends --input as the request body when the operation declares one", async () => {
    const calls = mockFetch(201, { id: "trg_0000" });
    await runResourceCommand(commandNamed("triggers", "create"), {
      ...AUTH,
      args: [],
      query: [],
      input: '{"url":"https://example.test/hook","events":["payment.settled"]}',
      json: true,
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      url: "https://example.test/hook",
      events: ["payment.settled"],
    });
  });

  it("refuses a body on an operation that declares none, before any request", async () => {
    const calls = mockFetch(200, {});
    await expect(
      runResourceCommand(commandNamed("sellers", "status"), {
        ...AUTH,
        args: ["slr_0000"],
        query: [],
        input: "{}",
      }),
    ).rejects.toThrow(/declares no request body/);
    expect(calls).toEqual([]);
  });

  it("scopes to the project when one is configured", async () => {
    const calls = mockFetch(200, {});
    await runResourceCommand(commandNamed("wallets", "list"), {
      ...AUTH,
      project: "prj_abcdefghij123456",
      args: [],
      query: [],
      json: true,
    });
    expect((calls[0]!.init.headers as Record<string, string>)["x-codespar-project"]).toBe(
      "prj_abcdefghij123456",
    );
  });

  it("surfaces the API's own error instead of inventing a result", async () => {
    mockFetch(404, { error: { code: "not_found", message: "wallet wal_0000 not found" } });
    await expect(
      runResourceCommand(commandNamed("wallets", "get"), {
        ...AUTH,
        args: ["wal_0000"],
        query: [],
        json: true,
      }),
    ).rejects.toBeInstanceOf(CodesparApiError);
  });
});
