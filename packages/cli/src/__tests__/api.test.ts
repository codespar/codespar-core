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

/**
 * `Content-Type: application/json` só quando há corpo.
 *
 * O header era incondicional, e a API recusa uma requisição que se anuncia
 * como JSON e chega vazia. Medido em 21/09/2026 contra `api.codespar.dev` com
 * a CLI 0.12.0 do npm:
 *
 *   codespar sessions close ses_...
 *   ✗ DELETE /v1/sessions/ses_... → 400: Body cannot be empty when
 *     content-type is set to 'application/json'
 *
 * Fechar sessão era o único comando deste cliente que manda DELETE, então era
 * o único que morria. O cliente gerado do SDK já fazia o certo: medido contra
 * um servidor local, `consumers delete-pix-keys` sai sem content-type nenhum.
 *
 * ⚠️ CONTROLE. Um teste que só exigisse "não manda no DELETE" passaria se
 * alguém removesse o header de vez, e aí todo POST quebraria. Os dois casos
 * estão aqui.
 */
describe("Content-Type acompanha o corpo, não o método", () => {
  async function headersDe(chamada: (c: ApiClient) => Promise<unknown>) {
    let captured: Record<string, string> = {};
    mockFetch((_url, init) => {
      captured = init.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.x.dev" });
    await chamada(client);
    return captured;
  }

  it("um DELETE sem corpo não se anuncia como JSON", async () => {
    const h = await headersDe((c) => c.delete("/v1/sessions/{id}", { path: { id: "ses_1" } }));
    expect(h["Content-Type"]).toBeUndefined();
    expect(h.Authorization).toBe("Bearer csk_test_x");
  });

  it("um GET sem corpo também não", async () => {
    const h = await headersDe((c) => c.get("/v1/sessions"));
    expect(h["Content-Type"]).toBeUndefined();
  });

  it("CONTROLE: um POST com corpo continua se anunciando como JSON", async () => {
    const h = await headersDe((c) => c.post("/v1/sessions", { body: { servers: [] } }));
    expect(h["Content-Type"]).toBe("application/json");
  });
});

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
