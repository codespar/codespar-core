/**
 * `codespar spend` names its `attempt_id` on every call (enterprise #2378, B1
 * of the pilot review). A Live project refuses a spend without one, and
 * without one a retry after a lost answer was a second payment.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spendCommand } from "../commands/spend.js";

afterEach(() => vi.restoreAllMocks());

function watch() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return bodies;
}

const base = {
  mandate: "cm_1",
  payee: "pix@example.com",
  amount: "100",
  agent: "agt_1",
  apiKey: "csk_test_x",
  baseUrl: "https://api.test.dev",
  json: true,
};

describe("codespar spend attempt_id", () => {
  it("sends the --attempt-id it was given, verbatim", async () => {
    const bodies = watch();
    await spendCommand({ ...base, attemptId: "retry-me-1" });
    expect(bodies[0]?.attempt_id).toBe("retry-me-1");
  });

  it("generates one when none is given, a new one per run", async () => {
    const bodies = watch();
    await spendCommand(base);
    await spendCommand(base);
    expect(String(bodies[0]?.attempt_id)).toMatch(/^cli_[0-9a-f-]{36}$/);
    expect(bodies[1]?.attempt_id).not.toBe(bodies[0]?.attempt_id);
  });
});

/**
 * The recovery a script actually gets: the built binary, `--json`, an API that
 * fails. The generated id must come back in the error document, or the only
 * copy of the key that makes a retry the same payment is lost with the answer.
 */
describe("codespar --json spend that fails hands back its attempt_id", () => {
  const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

  function run(args: string[], env: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "codespar-spend-"));
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(process.execPath, [BIN, ...args], {
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("close", (status) => done({ status, stdout, stderr }));
    });
  }

  it("a 503 answer: error.attempt_id is the generated id, and a given id comes back verbatim", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += String(d)));
      req.on("end", () => {
        seen.push(String((JSON.parse(raw || "{}") as { attempt_id?: string }).attempt_id));
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "upstream_unavailable", message: "try again" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const env = {
      CODESPAR_API_KEY: "csk_test_x",
      CODESPAR_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    };
    const args = ["--json", "spend", "-m", "cm_1", "-p", "pix@example.com", "-a", "100", "--agent", "agt_1"];
    try {
      const generated = await run(args, env);
      expect(generated.status).toBe(1);
      const doc = JSON.parse(generated.stdout) as { error: { kind: string; attempt_id?: string } };
      expect(doc.error.attempt_id).toMatch(/^cli_[0-9a-f-]{36}$/);
      expect(doc.error.attempt_id).toBe(seen[0]);
      expect(generated.stderr).toContain(String(doc.error.attempt_id));

      const given = await run([...args, "--attempt-id", "retry-me-2"], env);
      expect((JSON.parse(given.stdout) as { error: { attempt_id?: string } }).error.attempt_id).toBe("retry-me-2");
      expect(seen[1]).toBe("retry-me-2");
    } finally {
      server.close();
    }
  }, 60_000);
});
