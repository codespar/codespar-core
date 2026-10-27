/**
 * `codespar pix-keys list|register|delete`: what each command sends through
 * the SDK facade, how `--type` is read, and that `delete` without `--confirm`
 * sends nothing and says why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseKeyType, pixKeysDeleteCommand, pixKeysListCommand, pixKeysRegisterCommand } from "../commands/pix-keys.js";
import { CliError } from "../config.js";

const AUTH = { apiKey: "csk_test_example", baseUrl: "https://api.example.test", json: true };
const CONSUMER = "sbx_prj_abc123DEF456ghi7";
const EVP = "e3bd874d-f40d-4434-9569-10dc83e2e0e4";

interface Seen {
  method: string;
  path: string;
  body: BodyInit | null | undefined;
}

let seen: Seen[] = [];
let answer: (s: Seen) => Response;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let printed: string[] = [];

beforeEach(() => {
  seen = [];
  printed = [];
  answer = () => respond(200, {});
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const s: Seen = { method: init.method ?? "GET", path: new URL(url).pathname, body: init.body };
    seen.push(s);
    return answer(s);
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseKeyType", () => {
  it("defaults to EVP, upper-cases, and refuses a type the route does not take", () => {
    expect(parseKeyType(undefined)).toBe("EVP");
    expect(parseKeyType("cpf")).toBe("CPF");
    expect(() => parseKeyType("random")).toThrow(CliError);
  });
});

describe("codespar pix-keys", () => {
  it("list reads the consumer's keys", async () => {
    answer = () => respond(200, { account_masked: "••••27", keys: [{ key: EVP, key_type: "EVP" }], count: 1 });
    await pixKeysListCommand({ ...AUTH, consumer: CONSUMER });
    expect(seen).toEqual([{ method: "GET", path: `/v1/consumers/${CONSUMER}/pix-keys`, body: undefined }]);
    expect(JSON.parse(printed.join(""))).toMatchObject({ count: 1 });
  });

  it("register sends EVP by default and the value only with a value type; a value type without --key is refused before any request", async () => {
    answer = () => respond(201, { key: EVP, key_type: "EVP", account_masked: "••••27" });
    await pixKeysRegisterCommand({ ...AUTH, consumer: CONSUMER });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/v1/consumers/${CONSUMER}/pix-keys` });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ key_type: "EVP" });
    await expect(pixKeysRegisterCommand({ ...AUTH, consumer: CONSUMER, type: "EMAIL" })).rejects.toThrow(CliError);
    await expect(pixKeysRegisterCommand({ ...AUTH, consumer: CONSUMER, key: "x" })).rejects.toThrow(CliError);
    expect(seen).toHaveLength(1);
    await pixKeysRegisterCommand({ ...AUTH, consumer: CONSUMER, type: "email", key: "fulano@example.com" });
    expect(JSON.parse(String(seen[1]!.body))).toEqual({ key_type: "EMAIL", key: "fulano@example.com" });
  });

  it("delete without --confirm sends nothing and names the consequence; with it, sends the DELETE", async () => {
    answer = () => respond(200, { key: EVP, account_masked: "••••27", deleted: true });
    const err = await pixKeysDeleteCommand(EVP, { ...AUTH, consumer: CONSUMER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toContain("deixa de apontar");
    expect((err as Error).message).toContain("--confirm");
    expect(seen).toEqual([]);
    await pixKeysDeleteCommand(EVP, { ...AUTH, consumer: CONSUMER, confirm: true });
    expect(seen).toEqual([{ method: "DELETE", path: `/v1/consumers/${CONSUMER}/pix-keys/${EVP}`, body: undefined }]);
  });
});
