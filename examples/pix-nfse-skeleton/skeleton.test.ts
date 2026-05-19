/**
 * Pix + NFS-e walking skeleton — a 4-step `loop()` chain against the OSS
 * MCP bridge using --demo fixtures from @codespar/mcp-asaas and
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

describe("Pix + NFS-e walking skeleton", () => {
  it("runs the 4-step loop end-to-end against the demo bridge", async () => {
    const cs = new CodeSpar({
      apiKey: CODESPAR_API_KEY,
      baseUrl: CODESPAR_BASE_URL,
    });

    session = await cs.create(`pix-nfse-skeleton-${Date.now()}`, {
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
            name: "Cliente Demo",
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
            description: "Pix + NFS-e walking skeleton",
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
            servico: { descricao: "Serviço de teste — Pix + NFS-e walking skeleton" },
            valor: 150.0,
          },
        },
      ],
    };

    const result = await loop(session, config);

    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(4);

    // Step 1 — asaas/create_customer → cus_demo_*
    expect(result.results[0]!.success).toBe(true);
    const customer = result.results[0]!.data as { id: string };
    expect(customer.id).toMatch(/^cus_demo_/);

    // Step 2 — asaas/create_payment → pay_demo_*, billingType=PIX, value=150
    expect(result.results[1]!.success).toBe(true);
    const payment = result.results[1]!.data as {
      id: string;
      billingType: string;
      value: number;
      customer: string;
    };
    expect(payment.id).toMatch(/^pay_demo_/);
    expect(payment.billingType).toBe("PIX");
    expect(payment.value).toBe(150.0);
    expect(typeof payment.customer).toBe("string");

    // Step 3 — asaas/get_pix_qrcode → real BR-Code payload prefix
    // (`00020126…` is the BR-Code static-EMV envelope; the demo
    // fixture emits a payload starting with that header).
    expect(result.results[2]!.success).toBe(true);
    const qr = result.results[2]!.data as {
      payload: string;
      encodedImage: string;
    };
    expect(qr.payload).toMatch(/^00020126/);
    expect(typeof qr.encodedImage).toBe("string");
    expect(qr.encodedImage.length).toBeGreaterThan(0);

    // Step 4 — nuvem-fiscal/create_nfse → nfse_demo_*, status=autorizada,
    // numeric numero, numeric valorServico
    expect(result.results[3]!.success).toBe(true);
    const nfse = result.results[3]!.data as {
      id: string;
      status: string;
      numero: number;
      valorServico: number;
    };
    expect(nfse.id).toMatch(/^nfse_demo_/);
    expect(nfse.status).toBe("autorizada");
    expect(typeof nfse.numero).toBe("number");
    expect(typeof nfse.valorServico).toBe("number");

    // No step's dispatch reported failure (the bridge round-trips were
    // clean end-to-end, not just on the final aggregate flag).
    for (const r of result.results) {
      expect(r.success).toBe(true);
    }
  }, 30_000);

  afterAll(async () => {
    if (session) await session.close();
  });
});
