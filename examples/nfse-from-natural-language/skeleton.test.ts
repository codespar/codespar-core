/**
 * Service invoice from natural language — an LLM-driven end-to-end test
 * against the OSS MCP bridge using `session.send()`.
 *
 * One natural-language message in, two NFS-e issued, one WhatsApp
 * outbound carrying both PDF links. The LLM call goes through
 * @copilotkit/aimock (via the runtime's ANTHROPIC_BASE_URL) and the
 * MCP servers run with `--demo` to return deterministic fixtures.
 *
 * Source of truth for the fixture payloads: the two MCP packages with
 * `--demo` on their spawn line in `mcp-servers.json`, plus the aimock
 * fixture file at `./fixtures/aimock-fixtures.json`. The runtime is started
 * separately (see scripts/validate.sh) so its cwd matches this
 * directory and the bridge reads `./mcp-servers.json`.
 */

import { afterAll, describe, expect, it } from "vitest";
import { CodeSpar } from "@codespar/sdk";
import type { Session } from "@codespar/sdk";

// `local` is an OSS sentinel — the self-hosted runtime accepts any
// non-empty Bearer token. Managed mode replaces this with a real
// `csk_test_*` key.
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "local";
const CODESPAR_BASE_URL =
  process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";

let session: Session | undefined;

describe("Service invoice from natural language", () => {
  it("issues two NFS-e and delivers PDFs via WhatsApp from a natural-language message", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });

    session = await cs.create(`nfse-from-nl-${Date.now()}`, {
      servers: ["nuvem-fiscal", "z-api"],
    });

    const result = await session.send(
      "Need invoice for the platform access fee plus the onboarding consulting — R$2.800 platform, R$1.200 consulting.",
    );

    // ── Two NFS-e issued, both successful, both shaped like the
    //    stateful demo handler in @codespar/mcp-nuvem-fiscal returns. ──
    const nfseCalls = result.tool_calls.filter(
      (tc) => tc.tool_name === "nuvem-fiscal__create_nfse",
    );
    expect(nfseCalls).toHaveLength(2);

    // The agent must split the natural-language message into the two
    // LC 116/2003 service-code brackets — 1.05 (informacao e meios
    // eletronicos) for the SaaS access fee and 17.01 (consultoria) for
    // the onboarding work. Assert both inputs explicitly so a fixture
    // regression that flattens the codes back to a single bracket is
    // caught here, not in review.
    const nfseByCodigo = new Map<string, (typeof nfseCalls)[number]>();
    for (const tc of nfseCalls) {
      const args = tc.input as {
        servico?: { codigo?: string };
        valor?: number;
      };
      expect(typeof args.servico?.codigo).toBe("string");
      nfseByCodigo.set(args.servico!.codigo!, tc);
    }
    expect(nfseByCodigo.has("1.05")).toBe(true);
    expect(nfseByCodigo.has("17.01")).toBe(true);

    const platformCall = nfseByCodigo.get("1.05")!;
    const consultingCall = nfseByCodigo.get("17.01")!;
    expect((platformCall.input as { valor: number }).valor).toBe(2800);
    expect((consultingCall.input as { valor: number }).valor).toBe(1200);

    nfseCalls.forEach((tc) => {
      expect(tc.status).toBe("success");
      const data = tc.output as {
        id: string;
        status: string;
        pdf_url?: string;
      };
      expect(data.id).toMatch(/^nfse_demo_/);
      expect(data.status).toBe("autorizada");
      expect(typeof data.pdf_url).toBe("string");
      expect(data.pdf_url!.length).toBeGreaterThan(0);
    });

    // ── WhatsApp outbound carrying both PDF URLs. ──
    const sendCalls = result.tool_calls.filter(
      (tc) => tc.tool_name === "z-api__send_text",
    );
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    expect(sendCalls[0]!.status).toBe("success");
    const sendArgs = sendCalls[0]!.input as {
      phone?: string;
      message: string;
    };
    expect(sendArgs.message).toMatch(/nfse_demo_001/);
    expect(sendArgs.message).toMatch(/nfse_demo_002/);

    // ── Multi-turn loop — the LLM had to chain a tool-using turn and a
    //    text-only turn. At minimum: turn 1 emits the two NFS-e
    //    tool_use blocks, turn 2 emits the z-api tool_use, turn 3 emits
    //    the final text. That is three completion requests inside one
    //    session.send() and proves the tool loop actually iterated. ──
    expect(result.iterations).toBeGreaterThanOrEqual(3);
    expect(typeof result.message).toBe("string");

    // ── Every dispatched tool call succeeded — no swallowed failures. ──
    for (const tc of result.tool_calls) {
      expect(tc.status).toBe("success");
    }
  }, 60_000);

  afterAll(async () => {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort
      }
    }
  });
});
