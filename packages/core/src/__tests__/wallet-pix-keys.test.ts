/**
 * `cs.wallet.pixKeys`: the wire each call sends to
 * /v1/consumers/:consumerId/pix-keys (auth and project headers, the explicit
 * key_type, the key only for a non-random type, the encoded key in the
 * DELETE path), and that a delete without `{ confirm: true }` sends nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeSpar, CodesparApiError, PixKeyDeleteNotConfirmedError, PIX_KEY_DELETE_CONSEQUENCE } from "../index.js";

const BASE = "https://api.example.test";
const CONSUMER = "sbx_prj_abc123DEF456ghi7";
const EVP = "e3bd874d-f40d-4434-9569-10dc83e2e0e4";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: BodyInit | null | undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s: Seen = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body };
    seen.push(s);
    return answer(s);
  });
  const cs = new CodeSpar({ apiKey: "csk_test_example", baseUrl: BASE, projectId: "prj_abc123DEF456ghi7" });
  return { cs, seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cs.wallet.pixKeys", () => {
  it("list reads the account's keys with the key and project headers", async () => {
    const { cs, seen } = client(() => json(200, { account_masked: "••••27", keys: [{ key: EVP, key_type: "EVP" }], count: 1 }));
    const out = await cs.wallet.pixKeys.list(CONSUMER);
    expect(out.count).toBe(1);
    expect(out.keys[0]).toEqual({ key: EVP, key_type: "EVP" });
    expect(seen[0]).toMatchObject({ method: "GET", url: `${BASE}/v1/consumers/${CONSUMER}/pix-keys` });
    expect(seen[0]!.headers.Authorization).toBe("Bearer csk_test_example");
    expect(seen[0]!.headers["x-codespar-project"]).toBe("prj_abc123DEF456ghi7");
  });

  it("register sends the explicit key_type, and the key only for a non-random type", async () => {
    const { cs, seen } = client(() => json(201, { key: EVP, key_type: "EVP", account_masked: "••••27", cache_filled: true, reconciled: false }));
    const out = await cs.wallet.pixKeys.register(CONSUMER, { keyType: "EVP", key: "ignored for EVP" });
    expect(out.key).toBe(EVP);
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ key_type: "EVP" });
    await cs.wallet.pixKeys.register(CONSUMER, { keyType: "EMAIL", key: "fulano@example.com" });
    expect(JSON.parse(String(seen[1]!.body))).toEqual({ key_type: "EMAIL", key: "fulano@example.com" });
  });

  it("delete without { confirm: true } sends nothing and names the consequence", async () => {
    const { cs, seen } = client(() => json(200, {}));
    await expect(cs.wallet.pixKeys.delete(CONSUMER, EVP, { confirm: false })).rejects.toBeInstanceOf(PixKeyDeleteNotConfirmedError);
    await expect(cs.wallet.pixKeys.delete(CONSUMER, EVP, {} as never)).rejects.toMatchObject({
      code: "pix_key_delete_requires_confirmation",
      consequence: PIX_KEY_DELETE_CONSEQUENCE,
    });
    expect(seen).toEqual([]);
  });

  it("delete with { confirm: true } sends the DELETE with the key encoded in the path", async () => {
    const { cs, seen } = client(() => json(200, { key: "+5531999123456", account_masked: "••••27", deleted: true }));
    const out = await cs.wallet.pixKeys.delete(CONSUMER, "+5531999123456", { confirm: true });
    expect(out.deleted).toBe(true);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: `${BASE}/v1/consumers/${CONSUMER}/pix-keys/%2B5531999123456` });
  });

  it("the route's refusal surfaces with its status and code", async () => {
    const { cs } = client(() =>
      json(422, { error: { code: "pix_key_type_unavailable", message: "a Test project's own account registers only a random key" }, request_id: "req_x" }),
    );
    const err = await cs.wallet.pixKeys.register(CONSUMER, { keyType: "CPF", key: "11144477735" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodesparApiError);
    expect((err as CodesparApiError).status).toBe(422);
    expect((err as CodesparApiError).code).toBe("pix_key_type_unavailable");
  });
});
