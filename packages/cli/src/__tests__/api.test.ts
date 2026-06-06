import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiClient } from "../api.js";

type Init = { headers: Record<string, string>; signal?: AbortSignal };

function mockFetch(impl: (url: URL, init: Init) => Response | Promise<Response>) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input: unknown, init: unknown) =>
      Promise.resolve(impl(input as URL, init as Init)),
    );
}

afterEach(() => vi.restoreAllMocks());

describe("ApiClient", () => {
  it("sends Authorization + a versioned User-Agent + x-codespar-project when project is set", async () => {
    let captured: Record<string, string> = {};
    mockFetch((_url, init) => {
      captured = init.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new ApiClient({
      apiKey: "csk_test_x",
      baseUrl: "https://api.x.dev",
      project: "prj_abc",
    });
    await client.get("/v1/whoami");
    expect(captured["Authorization"]).toBe("Bearer csk_test_x");
    expect(captured["x-codespar-project"]).toBe("prj_abc");
    expect(captured["User-Agent"]).toMatch(/^codespar-cli\/\d+\.\d+\.\d+$/);
  });

  it("omits x-codespar-project when no project is configured", async () => {
    let captured: Record<string, string> = {};
    mockFetch((_url, init) => {
      captured = init.headers;
      return new Response("{}", { status: 200 });
    });
    await new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" }).get("/v1/whoami");
    expect(captured["x-codespar-project"]).toBeUndefined();
  });

  it("throws a CliError carrying the server's error detail on a non-2xx", async () => {
    mockFetch(() => new Response(JSON.stringify({ message: "bad key" }), { status: 401 }));
    const client = new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" });
    await expect(client.get("/v1/whoami")).rejects.toThrow(/401: bad key/);
  });

  it("returns undefined on 204 No Content", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const client = new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" });
    await expect(client.delete("/v1/sessions/s_1")).resolves.toBeUndefined();
  });

  it("aborts and surfaces a timeout CliError when the server hangs", async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const client = new ApiClient({
      apiKey: "csk_test_x",
      baseUrl: "https://api.x.dev",
      timeoutMs: 10,
    });
    await expect(client.get("/v1/whoami")).rejects.toThrow(/timed out after 10ms/);
  });
});
