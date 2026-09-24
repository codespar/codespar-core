/**
 * `codespar audit replay`: the chain verdict for an interval, asked of the API.
 *
 * The unit half watches `fetch` and pins the two paths the command calls, the
 * query it sends, the verdict it derives from the answer and the exit code it
 * sets. The process half runs the built binary against a local server, so the
 * `--json` contract a script really gets — one document on stdout, prose on
 * stderr — is asserted on the real streams.
 *
 * ⚠️ `process.exitCode` IS RESTORED AROUND EVERY UNIT CASE. The command sets it
 * to 1 on a verdict that is not `verified`, and a test that leaves it set makes
 * the whole vitest run exit 1 while reporting every case as passing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../api.js";
import { auditReplayCommand, decide } from "../commands/audit-replay.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

/** A health payload of the shape the served document declares. */
function health(over: Record<string, unknown> = {}) {
  const verification = {
    window_days: 90,
    watermark_sequence: 120,
    watermark_at: "2026-09-24T12:00:00.000Z",
    watermark_entry_hash: "abc",
    coverage_ratio: 1,
    hot_bucket_oldest_verified_at: null,
    hot_bucket_max_staleness_seconds: 3600,
    writer_tip_check_passed: true,
    writer_tip_check_at: "2026-09-24T12:00:01.000Z",
    chain_link_check: {
      unverifiable_segments: 0,
      oldest_unverifiable_segment: null,
      writer_tip_link_unverifiable: false,
      watermark_pinned_by_break_at: null,
    },
    ...((over.verification as Record<string, unknown>) ?? {}),
  };
  return {
    status: "healthy",
    last_sequence_number: 120,
    last_checked_at: "2026-09-24T12:00:01.000Z",
    detail: "chain verified through sequence 120",
    actionable_status: "healthy",
    incidents: { open_count: 0, acknowledged_count_30d: 0, open_truncated: false, open: [] },
    initial_walk: { in_progress: false, started_at: null, events_processed: 120 },
    ...over,
    verification,
  };
}

function events(sequences: number[], nextBefore: number | null = null) {
  return {
    events: sequences.map((n) => ({
      sequence_number: n,
      event_type: "tool_call.succeeded",
      happened_at: "2026-09-24T11:00:00.000Z",
      payload: {},
      prev_hash: "p",
      entry_hash: "e",
    })),
    next_before_sequence: nextBefore,
  };
}

describe("decide", () => {
  const span = { count: 3, firstSequence: 100, lastSequence: 110, truncated: false };

  it("a chain the API calls broken is broken, whatever the interval holds", () => {
    expect(decide("broken", 999, span).verdict).toBe("broken");
  });

  it("an open incident is degraded, and the reason says it was not intersected with the interval", () => {
    const d = decide("degraded", 999, span);
    expect(d.verdict).toBe("degraded");
    expect(d.reason).toContain("not");
  });

  it("an unverifiable stretch of chain is reported as absence of proof, not tampering", () => {
    const d = decide("link_unverifiable", 999, span);
    expect(d.verdict).toBe("link_unverifiable");
    expect(d.reason).toContain("absence of proof");
  });

  it("an interval at or below the watermark is verified", () => {
    expect(decide("healthy", 110, span).verdict).toBe("verified");
    expect(decide("healthy", 111, span).verdict).toBe("verified");
  });

  it("an interval reaching above the watermark is unverified, not verified", () => {
    expect(decide("healthy", 109, span).verdict).toBe("unverified");
    expect(decide("catching_up", 0, span).verdict).toBe("unverified");
    expect(decide("verifying", 0, span).verdict).toBe("unverified");
  });

  it("an empty interval is `no_events`, which is not a claim that anything was verified", () => {
    const d = decide("healthy", 120, { count: 0, firstSequence: null, lastSequence: null, truncated: false });
    expect(d.verdict).toBe("no_events");
    expect(d.reason).toContain("nothing to verify");
  });
});

describe("auditReplayCommand", () => {
  let exitCode: number | undefined;

  beforeEach(() => {
    exitCode = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  interface Call {
    method: string;
    path: string;
    search: string;
  }

  function watch(answers: Array<{ status?: number; body: unknown }>) {
    const calls: Call[] = [];
    let i = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search });
      const answer = answers[Math.min(i++, answers.length - 1)];
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
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

  const client = () => new ApiClient({ apiKey: "csk_test_x", baseUrl: "https://api.test.dev" });

  it("reads the health endpoint and the event listing, in that order, with the interval as ISO", async () => {
    const calls = watch([{ body: health() }, { body: events([110, 105, 100]) }]);
    capture(process.stdout);
    capture(process.stderr);

    await auditReplayCommand(client(), { from: "2026-09-24T00:00:00Z", to: "2026-09-24T23:59:59Z" });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/audit-events/health",
      "GET /v1/audit-events",
    ]);
    const query = new URLSearchParams(calls[1].search);
    expect(query.get("from")).toBe("2026-09-24T00:00:00.000Z");
    expect(query.get("to")).toBe("2026-09-24T23:59:59.000Z");
    expect(query.get("limit")).toBe("200");
    expect(query.get("before_sequence")).toBeNull();
  });

  it("never asks either deprecated alias (/v1/audit/events, /v1/orgs/{id}/audit/health)", async () => {
    const calls = watch([{ body: health() }, { body: events([110]) }]);
    capture(process.stdout);
    capture(process.stderr);
    await auditReplayCommand(client(), {});
    const paths = calls.map((c) => c.path);
    expect(paths).not.toContain("/v1/audit/events");
    expect(paths.some((p) => p.startsWith("/v1/orgs/"))).toBe(false);
  });

  it("--json writes exactly one document to stdout and puts the prose on stderr", async () => {
    watch([{ body: health() }, { body: events([110, 105, 100]) }]);
    const out = capture(process.stdout);
    const err = capture(process.stderr);

    await auditReplayCommand(client(), { from: "2026-09-24T00:00:00Z", json: true });

    const doc = JSON.parse(out.join(""));
    expect(doc.verdict).toBe("verified");
    expect(doc.interval).toEqual({ from: "2026-09-24T00:00:00.000Z", to: null });
    expect(doc.events).toEqual({ count: 3, first_sequence: 100, last_sequence: 110, truncated: false });
    expect(doc.chain.watermark_sequence).toBe(120);
    expect(doc.verified_by.chain_verdict).toBe("GET /v1/audit-events/health");
    expect(doc.verified_by.producer).toMatch(/^codespar-cli\//);
    expect(err.join("")).toContain("verified");
  });

  it("a verified interval leaves the exit code alone; anything else sets it to 1", async () => {
    watch([{ body: health() }, { body: events([110]) }]);
    capture(process.stdout);
    capture(process.stderr);
    process.exitCode = undefined;
    await auditReplayCommand(client(), { json: true });
    expect(process.exitCode).toBeUndefined();

    vi.restoreAllMocks();
    watch([{ body: health({ actionable_status: "broken", status: "degraded" }) }, { body: events([110]) }]);
    capture(process.stdout);
    capture(process.stderr);
    await auditReplayCommand(client(), { json: true });
    expect(process.exitCode).toBe(1);
  });

  it("walks the cursor while pages come back full, and reports the span across them", async () => {
    const page1 = events(Array.from({ length: 200 }, (_, i) => 400 - i), 201);
    const page2 = events([200, 199, 198]);
    watch([{ body: health({ verification: { watermark_sequence: 400 } }) }, { body: page1 }, { body: page2 }]);
    const out = capture(process.stdout);
    capture(process.stderr);

    await auditReplayCommand(client(), { json: true });

    const doc = JSON.parse(out.join(""));
    expect(doc.events).toEqual({ count: 203, first_sequence: 198, last_sequence: 400, truncated: false });
    expect(doc.verdict).toBe("verified");
  });

  it("an unreadable --from is refused before any request is made", async () => {
    const calls = watch([{ body: health() }]);
    await expect(auditReplayCommand(client(), { from: "last tuesday" })).rejects.toThrow(/ISO 8601/);
    expect(calls).toEqual([]);
  });

  it("an inverted interval is refused before any request is made", async () => {
    const calls = watch([{ body: health() }]);
    await expect(
      auditReplayCommand(client(), { from: "2026-09-24T10:00:00Z", to: "2026-09-24T09:00:00Z" }),
    ).rejects.toThrow(/--from is after --to/);
    expect(calls).toEqual([]);
  });

  it("a deployment without the audit-chain resource is a named refusal, not a raw 404", async () => {
    watch([{ status: 404, body: { error: "not_found" } }]);
    await expect(auditReplayCommand(client(), {})).rejects.toThrow(
      /does not serve GET \/v1\/audit-events\/health/,
    );
  });
});

describe("codespar audit replay, at the process level", () => {
  function run(args: string[], env: Record<string, string>) {
    const home = mkdtempSync(join(tmpdir(), "codespar-audit-"));
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

  async function serve(route: (req: IncomingMessage) => { status: number; body: unknown }) {
    const seen: Array<{ method: string; url: string; project: string | undefined }> = [];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          project: req.headers["x-codespar-project"] as string | undefined,
        });
        const answer = route(req);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const { port } = server.address() as AddressInfo;
    return { server, seen, base: `http://127.0.0.1:${port}` };
  }

  it("--json: one document on stdout, the project header carried, exit 0 when verified", async () => {
    const { server, seen, base } = await serve((req) =>
      req.url?.startsWith("/v1/audit-events/health")
        ? { status: 200, body: health() }
        : { status: 200, body: events([110, 105]) },
    );
    try {
      const r = await run(
        [
          "--json",
          "--project",
          "prj_0123456789abcdef",
          "audit",
          "replay",
          "--from",
          "2026-09-24T00:00:00Z",
          "--to",
          "2026-09-24T23:59:59Z",
        ],
        { CODESPAR_API_KEY: "csk_test_x", CODESPAR_BASE_URL: base },
      );
      expect(r.status).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc.verdict).toBe("verified");
      expect(doc.events.count).toBe(2);
      expect(seen.map((s) => s.url.split("?")[0])).toEqual([
        "/v1/audit-events/health",
        "/v1/audit-events",
      ]);
      expect(seen.every((s) => s.project === "prj_0123456789abcdef")).toBe(true);
      expect(r.stderr).toContain("verified");
    } finally {
      server.close();
    }
  }, 40_000);

  it("--json: an interval above the watermark is `unverified` on stdout and exit 1", async () => {
    const { server, base } = await serve((req) =>
      req.url?.startsWith("/v1/audit-events/health")
        ? { status: 200, body: health({ actionable_status: "catching_up", verification: { watermark_sequence: 90 } }) }
        : { status: 200, body: events([110, 105]) },
    );
    try {
      const r = await run(["--json", "audit", "replay"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: base,
      });
      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.verdict).toBe("unverified");
      expect(doc.chain.watermark_sequence).toBe(90);
      expect(doc.events.last_sequence).toBe(110);
    } finally {
      server.close();
    }
  }, 40_000);

  it("a backend without the resource refuses with a `cli` code, not a stack trace", async () => {
    const { server, base } = await serve(() => ({ status: 404, body: { error: "not_found" } }));
    try {
      const r = await run(["--json", "audit", "replay"], {
        CODESPAR_API_KEY: "csk_test_x",
        CODESPAR_BASE_URL: base,
      });
      expect(r.status).toBe(1);
      const doc = JSON.parse(r.stdout);
      expect(doc.error.kind).toBe("cli");
      expect(doc.error.code).toBe("audit_chain_unsupported");
      expect(r.stderr).not.toContain("at Object.");
    } finally {
      server.close();
    }
  }, 40_000);

  it("CONTROL: without a key it refuses before the network and makes no request", async () => {
    const { server, seen, base } = await serve(() => ({ status: 200, body: health() }));
    try {
      const r = await run(["--json", "audit", "replay"], { CODESPAR_BASE_URL: base });
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stdout).error.kind).toBe("cli");
      expect(seen).toEqual([]);
    } finally {
      server.close();
    }
  }, 40_000);
});
