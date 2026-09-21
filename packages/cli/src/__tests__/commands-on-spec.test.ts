/**
 * What the hand-written commands actually put on the wire.
 *
 * Six of them addressed routes the API does not have, and two more read a
 * field the payload does not carry (core#130). The types stop both classes
 * at compile time now, but a type cannot say which route a command chose,
 * so this file watches `fetch` and asserts the method and path of every
 * request, plus the fact that the old dead paths are never among them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api.js";
import { listConnectionsCommand, revokeConnectCommand } from "../commands/connect.js";
import { tailLogsCommand } from "../commands/logs.js";
import { listServersCommand, showServerCommand } from "../commands/servers.js";
import {
  closeSessionCommand,
  listSessionsCommand,
  showSessionCommand,
} from "../commands/sessions.js";
import { listToolsCommand, showToolCommand } from "../commands/tools.js";

/**
 * Paths these commands must never request. The first five never existed; the
 * last two exist and the served document buries them as DEPRECATED aliases
 * (`GET /v1/servers` of `GET /v1/providers`, and the auth-schema pair), which
 * is the same defect from the reader's side: the call works today and stops
 * working when the alias is dropped.
 */
const DEAD_PATHS = [
  "/v1/tools",
  "/v1/logs/stream",
  "/v1/sessions/s_1/close",
  "/v1/sessions/s_1/logs",
  "/v1/servers/adyen",
  "/v1/servers",
  "/v1/servers/adyen/auth-schema",
];

interface Call {
  method: string;
  path: string;
  search: string;
}

const calls: Call[] = [];

/** Answer each path with a payload of the shape the document declares. */
function serve(url: URL): unknown {
  const path = url.pathname;
  if (path === "/v1/providers") {
    return {
      total: 2,
      filtered: 2,
      servers: [
        { id: "adyen", name: "Adyen", category: "psp", country: "NL", status: "live", tools_count: 30, description: "Cards" },
        { id: "stripe", name: "Stripe", category: "psp", country: "US", status: "live", tools_count: 12 },
      ],
    };
  }
  if (/^\/v1\/servers\/[^/]+\/tools$/.test(path)) {
    return { server_id: "adyen", total: 2, tools: [{ name: "accept_dispute", description: "Accept" }, { name: "refund", description: null }] };
  }
  if (/^\/v1\/providers\/[^/]+\/auth-schema$/.test(path)) {
    return {
      server_id: "adyen",
      auth_type: "api_key",
      environment: "test",
      base_url: "https://x",
      oauth_authorize_url: null,
      fields: [{ name: "secret", kind: "api_key", label: "API Key", header_name: "X-Key" }],
    };
  }
  if (path === "/v1/sessions") return { sessions: [{ id: "ses_1", user_id: "u", status: "active", servers: [], created_at: "2026-09-01T00:00:00.000Z" }], next_before: null };
  if (/^\/v1\/sessions\/[^/]+\/tool-calls$/.test(path)) {
    return { tool_calls: [{ id: "tc_1", tool_name: "codespar_pay", server_id: "celcoin", status: "success", duration_ms: 12, called_at: "2026-09-01T00:00:01.000Z" }] };
  }
  if (/^\/v1\/sessions\/[^/]+$/.test(path)) {
    return { id: "ses_1", org_id: "o", project_id: "p", user_id: "u", servers: [], status: "closed", created_at: "2026-09-01T00:00:00.000Z", closed_at: "2026-09-01T01:00:00.000Z", tool_calls_count: 3 };
  }
  if (path === "/v1/tool-calls") {
    const since = url.searchParams.get("since");
    if (since) return { tool_calls: [], next_before: null };
    return {
      tool_calls: [
        { id: "tc_2", tool_name: "codespar_shop", server_id: "rinne", status: "error", error_code: "denied", duration_ms: 3, called_at: "2026-09-01T00:00:03.000Z" },
        { id: "tc_1", tool_name: "codespar_pay", server_id: "celcoin", status: "success", duration_ms: 12, called_at: "2026-09-01T00:00:01.000Z" },
      ],
      next_before: null,
    };
  }
  if (path === "/v1/connections") return { connections: [{ id: "ca_1", user_id: "u", server_id: "adyen", auth_type: "api_key", status: "connected", display_name: null, metadata: null, connection_metadata: {}, cert_metadata: {}, created_at: "2026-09-01T00:00:00.000Z", connected_at: "2026-09-01T00:00:02.000Z", revoked_at: null, expires_at: null }] };
  if (/^\/v1\/connections\/[^/]+\/revoke$/.test(path)) return { revoked: true };
  throw new Error(`the test server has no route for ${path}`);
}

function client(): ApiClient {
  return new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" });
}

vi.spyOn(process.stdout, "write").mockImplementation(() => true);
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.spyOn(globalThis, "fetch").mockImplementation((input: unknown, init: unknown) => {
  const url = input as URL;
  calls.push({
    method: (init as { method: string }).method,
    path: url.pathname,
    search: url.search,
  });
  return Promise.resolve(new Response(JSON.stringify(serve(url)), { status: 200 }));
});

afterEach(() => {
  calls.length = 0;
});

describe("the commands that used to call a route that does not exist", () => {
  it("lists tools from the server that exposes them", async () => {
    await listToolsCommand(client(), { server: "adyen" });
    expect(calls).toEqual([{ method: "GET", path: "/v1/servers/adyen/tools", search: "" }]);
  });

  it("refuses to list tools with no server, naming what to run instead", async () => {
    await expect(listToolsCommand(client(), {})).rejects.toThrow(/codespar servers list/);
    expect(calls).toEqual([]);
  });

  it("finds one tool inside its server's listing", async () => {
    await showToolCommand(client(), "accept_dispute", { server: "adyen" });
    expect(calls.map((c) => c.path)).toEqual(["/v1/servers/adyen/tools"]);
  });

  it("says which tools exist when the name is not one of them", async () => {
    await expect(showToolCommand(client(), "nope", { server: "adyen" })).rejects.toThrow(
      /exposes no tool called "nope".*codespar tools list --server adyen/s,
    );
  });

  it("assembles one server from the catalog, its tools and its auth schema", async () => {
    await showServerCommand(client(), "adyen", {});
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/providers",
      "GET /v1/servers/adyen/tools",
      "GET /v1/providers/adyen/auth-schema",
    ]);
  });

  it("refuses an id the catalog does not carry, without calling the per-server routes", async () => {
    await expect(showServerCommand(client(), "ghost", {})).rejects.toThrow(/No server with id "ghost"/);
    expect(calls.map((c) => c.path)).toEqual(["/v1/providers"]);
  });

  it("closes a session with the documented DELETE", async () => {
    await closeSessionCommand(client(), "ses_1");
    expect(calls).toEqual([{ method: "DELETE", path: "/v1/sessions/ses_1", search: "" }]);
  });

  it("reads a session's tool calls for --logs", async () => {
    await showSessionCommand(client(), "ses_1", { logs: true });
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/sessions/ses_1",
      "/v1/sessions/ses_1/tool-calls",
    ]);
  });

  it("does not read the tool calls when --logs is absent", async () => {
    await showSessionCommand(client(), "ses_1", {});
    expect(calls.map((c) => c.path)).toEqual(["/v1/sessions/ses_1"]);
  });

  it("reads the tool-call log instead of a stream that was never served", async () => {
    await tailLogsCommand(client(), { limit: "2" });
    expect(calls).toEqual([{ method: "GET", path: "/v1/tool-calls", search: "?limit=2" }]);
  });
});

describe("the commands that read a field the payload does not carry", () => {
  it("lists servers out of `servers`, and passes the filters the document declares", async () => {
    await listServersCommand(client(), { category: "psp", country: "BR", q: "pix" });
    expect(calls[0]?.path).toBe("/v1/providers");
    const params = new URLSearchParams(calls[0]?.search);
    expect([...params]).toEqual([
      ["category", "psp"],
      ["country", "BR"],
      ["q", "pix"],
    ]);
  });

  it("lists sessions out of `sessions`", async () => {
    await listSessionsCommand(client(), {});
    expect(calls).toEqual([{ method: "GET", path: "/v1/sessions", search: "" }]);
  });

  it("drops a filter that was not given rather than sending it empty", async () => {
    await listServersCommand(client(), { category: "psp" });
    expect(calls[0]?.search).toBe("?category=psp");
  });
});

describe("connections", () => {
  it("lists and revokes through the declared paths", async () => {
    await listConnectionsCommand(client(), { user: "u", status: "connected" });
    await revokeConnectCommand(client(), "ca_1", {});
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/connections",
      "POST /v1/connections/ca_1/revoke",
    ]);
  });

  it("refuses a status outside the vocabulary the listing declares", async () => {
    await expect(
      listConnectionsCommand(client(), { status: "revogada" }),
    ).rejects.toThrow(/pending, connected, revoked, expired/);
    expect(calls).toEqual([]);
  });
});

describe("control: none of the dead paths is ever requested", () => {
  it("holds across every command exercised above", async () => {
    const c = client();
    await listToolsCommand(c, { server: "adyen" });
    await showToolCommand(c, "refund", { server: "adyen" });
    await showServerCommand(c, "stripe", {});
    await listServersCommand(c, {});
    await listSessionsCommand(c, {});
    await showSessionCommand(c, "s_1", { logs: true });
    await closeSessionCommand(c, "s_1");
    await tailLogsCommand(c, {});

    expect(calls.length).toBeGreaterThan(8);
    for (const dead of DEAD_PATHS) {
      expect(calls.map((call) => call.path)).not.toContain(dead);
    }
  });
});

describe("path expansion", () => {
  it("refuses a missing path parameter before anything is sent", async () => {
    await expect(closeSessionCommand(client(), "")).rejects.toThrow(/Session id is required/);
    expect(calls).toEqual([]);
  });
});
