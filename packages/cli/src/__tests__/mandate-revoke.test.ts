/**
 * `codespar mandate revoke <id>`: the terminal verb of the org-scoped
 * mandate lifecycle, over `POST /v1/mandates/{id}/revoke`.
 *
 * The unit half watches `fetch` and pins the method, the canonical path
 * (not the deprecated `/v1/consumers/mandates/...` alias) and the body.
 * The process half runs the built binary against a local server, so the
 * `--json` document and the 409 → `error.kind: "api"` mapping are the
 * ones a script really gets.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../api.js";
import { mandateRevokeCommand } from "../commands/mandate-revoke.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

afterEach(() => vi.restoreAllMocks());

describe("mandateRevokeCommand", () => {
  function watch(answer: unknown, status = 200) {
    const calls: Array<{ method: string; path: string; body: string | null; contentType: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: init?.body === undefined ? null : String(init.body),
        contentType: headers.get("content-type"),
      });
      return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  function capture(stream: NodeJS.WriteStream) {
    const chunks: string[] = [];
    vi.spyOn(stream, "write").mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    return chunks;
  }

  it("POSTs the canonical path with the reason as the body, and prints the document with --json", async () => {
    const calls = watch({ mandate: { id: "mdt_1", status: "revoked" }, changed: true });
    const out = capture(process.stdout);
    const err = capture(process.stderr);

    await mandateRevokeCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), "mdt_1", {
      reason: "consumer asked",
      json: true,
    });

    expect(calls).toEqual([
      { method: "POST", path: "/v1/mandates/mdt_1/revoke", body: '{"reason":"consumer asked"}', contentType: "application/json" },
    ]);
    expect(JSON.parse(out.join(""))).toEqual({ mandate: { id: "mdt_1", status: "revoked" }, changed: true });
    expect(err.join("")).toContain("Mandate mdt_1 revoked.");
  });

  it("sends no body and no content-type without --reason (the API refuses an empty JSON body)", async () => {
    const calls = watch({ mandate: { id: "mdt_1", status: "revoked" }, changed: true });
    capture(process.stderr);

    await mandateRevokeCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), "mdt_1");

    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/mandates/mdt_1/revoke", body: null, contentType: null });
  });

  it("an already-revoked mandate is reported as unchanged, not as a failure", async () => {
    watch({ mandate: { id: "mdt_1", status: "revoked" }, changed: false });
    const out = capture(process.stdout);
    const err = capture(process.stderr);

    await mandateRevokeCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), "mdt_1", { json: true });

    expect(err.join("")).toContain("already revoked; nothing changed");
    expect(JSON.parse(out.join("")).changed).toBe(false);
  });

  it("never touches the deprecated /v1/consumers/mandates alias", async () => {
    const calls = watch({ mandate: { id: "mdt_1", status: "revoked" }, changed: true });
    capture(process.stderr);
    await mandateRevokeCommand(new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" }), "mdt_1");
    expect(calls.map((c) => c.path)).not.toContain("/v1/consumers/mandates/mdt_1/revoke");
  });
});

describe("codespar mandate revoke, at the process level", () => {
  function run(args: string[], env: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "codespar-revoke-"));
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, USERPROFILE: home, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  }

  async function serve(handler: (req: IncomingMessage, body: string) => { status: number; body: unknown }) {
    const seen: Array<{ method: string; url: string; body: string; project: string | undefined }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += String(d)));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body, project: req.headers["x-codespar-project"] as string | undefined });
        const answer = handler(req, body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    return { server, seen, base: `http://127.0.0.1:${port}` };
  }

  it("--json: the API's document on stdout, the project header carried, exit 0", async () => {
    const { server, seen, base } = await serve(() => ({
      status: 200,
      body: { mandate: { id: "mdt_42", status: "revoked" }, changed: true },
    }));
    try {
      const r = await run(["--json", "--project", "prj_0123456789abcdef", "mandate", "revoke", "mdt_42", "--reason", "done"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: base,
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ mandate: { id: "mdt_42", status: "revoked" }, changed: true });
      expect(seen).toEqual([
        { method: "POST", url: "/v1/mandates/mdt_42/revoke", body: '{"reason":"done"}', project: "prj_0123456789abcdef" },
      ]);
      expect(r.stderr).toContain("Mandate mdt_42 revoked.");
    } finally {
      server.close();
    }
  }, 40_000);

  it("a 409 invalid_transition is an `api` failure carrying status, code and body, exit 1", async () => {
    const refusal = {
      error: { code: "invalid_transition", message: "cannot revoke a mandate whose status is expired" },
      request_id: null,
    };
    const { server, base } = await serve(() => ({ status: 409, body: refusal }));
    try {
      const r = await run(["--json", "mandate", "revoke", "mdt_expired"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: base,
      });
      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.error.kind).toBe("api");
      expect(doc.error.status).toBe(409);
      expect(doc.error.body).toEqual(refusal);
      expect(r.stderr).toContain("409");
    } finally {
      server.close();
    }
  }, 40_000);

  it("CONTROL: without a key it is a `cli` refusal and no request is made", async () => {
    const { server, seen, base } = await serve(() => ({ status: 200, body: {} }));
    try {
      const r = await run(["--json", "mandate", "revoke", "mdt_42"], { CODESPAR_BASE_URL: base });
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).error.kind).toBe("cli");
      expect(seen).toEqual([]);
    } finally {
      server.close();
    }
  }, 40_000);
});
