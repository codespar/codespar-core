/**
 * P3 walking skeleton — 4-step Pix + NFS-e loop against the OSS MCP
 * bridge using --demo fixtures from @codespar/mcp-asaas and
 * @codespar/mcp-nuvem-fiscal.
 *
 * Source of truth for fixture payloads: those two MCP packages with
 * `--demo` on their spawn line (see mcp-servers.json). The runtime is
 * started separately (see scripts/validate.sh) so its cwd matches this
 * directory and the bridge reads `./mcp-servers.json`.
 */

import { afterAll, describe, expect, it } from "vitest";
import { CodeSpar, loop } from "@codespar/sdk";
import type { LoopConfig, Session, ToolResult } from "@codespar/sdk";

// `local` is an OSS sentinel — the self-hosted runtime accepts any
// non-empty Bearer token. Managed mode replaces this with a real
// `csk_test_*` key.
const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY ?? "local";
const CODESPAR_BASE_URL =
  process.env.CODESPAR_BASE_URL ?? "http://localhost:3000";

let session: Session | undefined;

describe("P3 walking skeleton", () => {
  it("runs the 4-step loop end-to-end against the demo bridge", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });

    session = await cs.create(`p3-skeleton-${Date.now()}`, {
      servers: ["asaas", "nuvem-fiscal"],
    });

    const dueDate = new Date(Date.now() + 86_400_000)
      .toISOString()
      .slice(0, 10);

    const config: LoopConfig = {
      steps: [
        {
          tool: "asaas/create_customer",
          params: {
            name: "Cliente Demo P3",
            cpfCnpj: "11144477735",
            email: "cliente@example.com",
            mobilePhone: "21995302656",
          },
        },
        {
          tool: "asaas/create_payment",
          params: (prev: ToolResult[]) => ({
            customer: (prev[0]!.data as { id: string }).id,
            billingType: "PIX",
            value: 150.0,
            dueDate,
            description: "P3 walking skeleton",
          }),
        },
        {
          tool: "asaas/get_pix_qrcode",
          params: (prev: ToolResult[]) => ({
            id: (prev[1]!.data as { id: string }).id,
          }),
        },
        {
          tool: "nuvem-fiscal/create_nfse",
          params: {
            servico: { descricao: "Serviço de teste P3 walking skeleton" },
            valor: 150.0,
          },
        },
      ],
    };

    const result = await loop(session, config);

    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(4);
    expect(result.results[0]!.success).toBe(true);
    expect((result.results[1]!.data as { id: string }).id).toMatch(/^pay_/);
    expect(
      (result.results[2]!.data as { payload: string }).payload.length,
    ).toBeGreaterThan(0);
    expect((result.results[3]!.data as { id: string }).id).toMatch(/^nfse_/);
    expect((result.results[3]!.data as { status: string }).status).toBe(
      "autorizada",
    );
  }, 30_000);

  afterAll(async () => {
    if (session) await session.close();
  });
});
