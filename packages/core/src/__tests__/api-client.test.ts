/**
 * The generated REST client: every operation of the snapshot is
 * reachable (URL, method, content types all come from the generated
 * table), and the transport behaves like the rest of the SDK.
 */

import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { ApiClient, createApiClient } from "../api/client.js";
import type { ApiPathsFor, ApiRequestOptions, ApiSuccess, ApiOperation } from "../api/types.js";
import { API_OPERATIONS } from "../generated/operations.js";
import { CodeSpar } from "../index.js";
import { CodesparApiError, TimeoutError } from "../errors.js";

const BASE = "https://api.example.test";
const KEY = "csk_test_example";

type Call = { url: string; init: RequestInit };

function stubFetch(
  respond: (call: Call) => Response | Promise<Response> = () => json({}),
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function client(extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  return createApiClient({ baseUrl: BASE, apiKey: KEY, timeout: 5000, ...extra });
}

// The untyped door for the coverage sweep: the typed signature refuses a
// string that is not a declared path, which is the point of the types
// and the wrong shape for a loop over all of them.
type Loose = {
  response: (method: string, path: string, opts?: unknown) => Promise<unknown>;
  request: (method: string, path: string, opts?: unknown) => Promise<unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coverage: every operation in the generated table is dispatchable", () => {
  it("reaches all operations of the snapshot with the documented method, URL and content types", async () => {
    const calls = stubFetch((call) =>
      call.init.headers && (call.init.headers as Record<string, string>).Accept === "text/event-stream"
        ? new Response("event: done\ndata: {}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })
        : json({ ok: true }),
    );
    const api = client() as unknown as Loose;

    let reached = 0;
    for (const row of API_OPERATIONS) {
      const names = [...row.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const pathParams = Object.fromEntries(names.map((n) => [n, `${n}-value`]));
      const expectedUrl =
        BASE + row.path.replace(/\{([^}]+)\}/g, (_, n: string) => encodeURIComponent(`${n}-value`));

      const before = calls.length;
      const result = (await api.response(row.method, row.path, {
        path: pathParams,
        body: row.body ? { example: "value" } : undefined,
      })) as { status: number; ok: boolean };

      expect(calls.length, `${row.method} ${row.path} made one request`).toBe(before + 1);
      const call = calls[before]!;
      expect(call.url, `${row.method} ${row.path} URL`).toBe(expectedUrl);
      expect(call.init.method, `${row.method} ${row.path} method`).toBe(row.method.toUpperCase());
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      if (row.accept) expect(headers.Accept, `${row.method} ${row.path} Accept`).toBe(row.accept);
      else expect(headers.Accept).toBeUndefined();
      if (row.body) {
        expect(headers["Content-Type"], `${row.method} ${row.path} Content-Type`).toBe(row.body);
        expect(call.init.body).toBeDefined();
      } else {
        expect(call.init.body).toBeUndefined();
      }
      expect(result.ok).toBe(true);
      reached += 1;
    }

    expect(reached).toBe(API_OPERATIONS.length);
    // The number the PR claims. Stated here so a snapshot refresh that
    // drops routes has to change this line on purpose.
    expect(API_OPERATIONS.length).toBe(213);
  });

  it("refuses a method/path pair the document does not declare, before any request", async () => {
    const calls = stubFetch();
    const api = client() as unknown as Loose;
    await expect(api.request("get", "/v1/not-in-the-document")).rejects.toThrow(
      /not an operation of the OpenAPI document/,
    );
    await expect(api.request("put", "/v1/wallets")).rejects.toThrow(/PUT \/v1\/wallets is not/);
    expect(calls).toHaveLength(0);
  });
});

describe("request shaping", () => {
  it("encodes path parameters and refuses a missing one before fetching", async () => {
    const calls = stubFetch();
    const api = client();
    await api.get("/v1/wallets/{id}", { path: { id: "wal_a/b c" } });
    expect(calls[0]!.url).toBe(`${BASE}/v1/wallets/wal_a%2Fb%20c`);

    await expect(
      (api as unknown as Loose).request("get", "/v1/wallets/{id}", { path: {} }),
    ).rejects.toThrow(/missing path parameter id/);
    expect(calls).toHaveLength(1);
  });

  it("serialises query parameters, repeating arrays and skipping undefined", async () => {
    const calls = stubFetch();
    const api = client() as unknown as Loose;
    await api.request("get", "/v1/wallets", {
      query: { limit: 10, status: ["a", "b"], cursor: undefined, flag: false },
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/wallets");
    expect(url.searchParams.getAll("status")).toEqual(["a", "b"]);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("flag")).toBe("false");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("sends JSON bodies with the documented content type", async () => {
    const calls = stubFetch(() => json({ id: "wal_example" }, 201));
    const api = client();
    const wallet = await api.post("/v1/wallets", {
      body: { display_name: "Example wallet", currency: "BRL" },
    });
    expect(wallet).toEqual({ id: "wal_example" });
    expect(calls[0]!.init.body).toBe(
      JSON.stringify({ display_name: "Example wallet", currency: "BRL" }),
    );
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("sends form bodies for x-www-form-urlencoded operations", async () => {
    const calls = stubFetch();
    const api = client();
    await api.post("/oauth/token", {
      body: { grant_type: "authorization_code", code: "code-value" },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(String(calls[0]!.init.body)).toBe("grant_type=authorization_code&code=code-value");
  });

  it("carries the project scope and per-call header parameters", async () => {
    const calls = stubFetch();
    const api = client({ projectId: "prj_abc123DEF456ghi7" });
    await api.patch("/v1/audit-events/config", {
      header: { "x-codespar-user": "user_example" },
      body: {},
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
    expect(headers["x-codespar-user"]).toBe("user_example");
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const calls = stubFetch();
    await client({ baseUrl: `${BASE}/` }).get("/v1/health");
    expect(calls[0]!.url).toBe(`${BASE}/v1/health`);
  });
});

describe("responses and errors", () => {
  it("request() throws CodesparApiError with the parsed body on a non-2xx", async () => {
    stubFetch(() => json({ error: "not_found" }, 404));
    const api = client();
    const err = await api.get("/v1/wallets/{id}", { path: { id: "wal_missing" } }).catch((e) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.body).toEqual({ error: "not_found" });
    expect(err.message).toMatch(/^GET \/v1\/wallets\/\{id\} failed: 404/);
  });

  it("response() returns non-2xx statuses as values, discriminated on status", async () => {
    stubFetch(() => json({ status: "requires-approval" }, 402));
    const api = client();
    const r = await api.response("post", "/v1/wallets/{id}/execute", {
      path: { id: "wal_example" },
      body: {
        amount: 1,
        currency: "BRL",
        recipient: "recipient-example",
        description: "example",
        mandate_id: "mnd_example",
      },
    });
    expect(r.status).toBe(402);
    expect(r.ok).toBe(false);
    expect(r.data).toEqual({ status: "requires-approval" });
    expect(r.response.status).toBe(402);
  });

  it("returns undefined for an empty body and text for a non-JSON one", async () => {
    stubFetch((call) =>
      call.url.endsWith("/v1/health")
        ? new Response(null, { status: 204 })
        : new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const api = client();
    expect(await api.get("/v1/health")).toBeUndefined();
    expect(await api.get("/oauth/authorize", { query: {} as never })).toBe("<html></html>");
  });

  it("returns the raw Response for text/event-stream operations", async () => {
    stubFetch(
      () =>
        new Response("event: snapshot\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const api = client();
    const res = await api.get("/v1/tool-calls/{id}/payment-status/stream", {
      path: { id: "tc_example" },
    });
    expect(res).toBeInstanceOf(Response);
    expect(await res.text()).toContain("event: snapshot");
  });

  it("maps a fetch rejection to CodesparApiError status 0 with the cause attached", async () => {
    const boom = new TypeError("fetch failed");
    vi.stubGlobal("fetch", async () => {
      throw boom;
    });
    const err = await client().get("/v1/health").catch((e) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect(err.status).toBe(0);
    expect(err.cause).toBe(boom);
  });

  it("times out with TimeoutError when the backend never answers", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const err = await client().get("/v1/health", { timeout: 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.timeoutMs).toBe(20);
  });

  it("propagates the caller's abort reason verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    );
    const ac = new AbortController();
    const reason = new Error("caller cancelled");
    const pending = client().get("/v1/health", { signal: ac.signal });
    ac.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("rejects an invalid per-call timeout before fetching", async () => {
    const calls = stubFetch();
    await expect(client().get("/v1/health", { timeout: 0 })).rejects.toThrow(/timeout must be/);
    expect(calls).toHaveLength(0);
  });
});

describe("CodeSpar.api", () => {
  it("shares the client's credentials, base URL, project and timeout", async () => {
    const calls = stubFetch();
    const cs = new CodeSpar({
      apiKey: KEY,
      baseUrl: BASE,
      projectId: "prj_abc123DEF456ghi7",
      timeout: 1234,
    });
    expect(cs.api).toBeInstanceOf(ApiClient);
    await cs.api.get("/v1/whoami");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.url).toBe(`${BASE}/v1/whoami`);
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
  });
});

describe("README examples (the three snippets, compiled and dispatched)", () => {
  it("list wallets, create a payment, read a receipt", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/execute")
        ? json({ status: "requires-approval" }, 402)
        : call.url.includes("/receipts/")
          ? json({ receipt_id: "rcpt_example", state: "paid" })
          : json([]),
    );
    const cs = new CodeSpar({ apiKey: KEY, baseUrl: BASE });

    const wallets = await cs.api.get("/v1/wallets");
    expect(wallets).toEqual([]);

    const payment = await cs.api.response("post", "/v1/wallets/{id}/execute", {
      path: { id: "wal_example" },
      body: {
        amount: 1,
        currency: "BRL",
        recipient: "recipient@example.com",
        description: "Example payment",
        mandate_id: "mnd_example",
      },
    });
    expect(payment.status).toBe(402);
    if (payment.status === 402) expect(payment.data.status).toBe("requires-approval");

    const receipt = await cs.api.get("/v1/consumers/receipts/{id}", {
      path: { id: "rcpt_example" },
    });
    expect(receipt.state).toBe("paid");

    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1/wallets",
      "POST /v1/wallets/wal_example/execute",
      "GET /v1/consumers/receipts/rcpt_example",
    ]);
  });
});

describe("types (checked by tsc, not at runtime)", () => {
  it("path parameters are required where the document declares them", () => {
    type WalletGet = ApiOperation<"/v1/wallets/{id}", "get">;
    expectTypeOf<ApiRequestOptions<WalletGet>["path"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ApiSuccess<WalletGet>>().toHaveProperty("id");

    type Health = ApiOperation<"/v1/health", "get">;
    expectTypeOf<ApiRequestOptions<Health>>().toMatchTypeOf<{ path?: never; body?: never }>();

    // A path that does not declare the method is not an accepted argument.
    expectTypeOf<"/v1/wallets">().toMatchTypeOf<ApiPathsFor<"post">>();
    expectTypeOf<"/v1/health">().not.toMatchTypeOf<ApiPathsFor<"post">>();
  });
});
