/**
 * Brazilian e-commerce in ~50 lines — the companion code to the LinkedIn
 * post at https://codespar.dev/blog/brazilian-ecommerce-50-lines.
 *
 * Two webhook endpoints:
 *
 *   POST /whatsapp   — buyer sends an order on WhatsApp; server creates a
 *                      Pix charge and replies with the QR copy-paste code.
 *
 *   POST /pix-paid   — Asaas fires this when the Pix settles; server issues
 *                      the NF-e, generates the shipping label, and confirms
 *                      the tracking code on WhatsApp.
 *
 * Everything in between — credential resolution, provider-specific quirks,
 * retry on async state (Asaas Pix QR attaches to the payment a few hundred
 * milliseconds after create), and logging — is handled by the SDK.
 *
 * Usage:
 *   export CODESPAR_API_KEY=csk_live_xxxxx      # or csk_test_ for sandbox
 *   export NFE_COMPANY_ID=<your NFe.io company> # required to emit NF-e
 *   npm install
 *   npm start
 *
 * Prerequisites:
 *   - A CodeSpar project with these 4 providers connected (green in the
 *     dashboard): asaas, nfe-io, melhor-envio, z-api. See
 *     https://codespar.dev/docs/connect for the one-time setup.
 *   - An NFe.io company registered — emitter CNPJ, regime tributário, CFOP.
 *     Can be homologação (SEFAZ sandbox) for testing.
 *
 * Not in scope for a ~50-line demo (handle these in production):
 *   - Webhook signature verification (Asaas signs payloads — always verify)
 *   - Idempotency keys on the webhook (Asaas retries on 5xx)
 *   - Product catalog lookup (price comes from the request body here)
 *   - Error recovery beyond the SDK's built-in retry (rollback, compensation)
 */

import { CodeSpar, loop } from "@codespar/sdk";
import Fastify from "fastify";

const cs = new CodeSpar();
const app = Fastify({ logger: true });

type Item = { sku: string; price: number; qty: number };

const COMPANY_ID = process.env.NFE_COMPANY_ID;
if (!COMPANY_ID) {
  console.error("❌ NFE_COMPANY_ID not set. Register a company at https://nfe.io and export its id.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// POST /whatsapp — buyer sends an order message; server creates a Pix
// charge and replies with the QR copy-paste code.
// ─────────────────────────────────────────────────────────────────────
app.post<{
  Body: { phone: string; name: string; cpf: string; items: Item[] };
}>("/whatsapp", async (req) => {
  const { phone, name, cpf, items } = req.body;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const session = await cs.create(phone);

  const r = await loop(session, {
    steps: [
      // Asaas requires an explicit customer reference before any charge —
      // you can't create a payment against a CPF directly. One-time cost
      // per buyer; cache the returned id if the same customer comes back.
      {
        tool: "asaas/create_customer",
        params: { name, cpfCnpj: cpf, mobilePhone: phone },
      },
      {
        tool: "asaas/create_payment",
        params: (prev) => ({
          customer: (prev[0]!.data as { id: string }).id,
          billingType: "PIX",
          value: total,
          dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        }),
      },
      // The Pix QR is attached asynchronously — it's ready a few hundred
      // milliseconds after create_payment. The SDK retries this step on
      // `invalid_action` automatically; no code here needs to know.
      {
        tool: "asaas/get_pix_qrcode",
        params: (prev) => ({ id: (prev[1]!.data as { id: string }).id }),
      },
      {
        tool: "z-api/send_text",
        params: (prev) => ({
          phone,
          message: `Seu Pix: ${(prev[2]!.data as { payload: string }).payload}`,
        }),
      },
    ],
  });

  return { payment_id: (r.results[1]!.data as { id: string }).id };
});

// ─────────────────────────────────────────────────────────────────────
// POST /pix-paid — Asaas webhook fires when the Pix settles. Emit the
// NF-e, generate the Melhor Envio label, confirm on WhatsApp.
// ─────────────────────────────────────────────────────────────────────
app.post<{
  Body: { payment_id: string; phone: string; buyer: object; items: Item[] };
}>("/pix-paid", async (req) => {
  const { payment_id, phone, buyer, items } = req.body;
  const session = await cs.create(phone);

  await loop(session, {
    steps: [
      {
        tool: "nfe-io/create_nfe",
        params: {
          company_id: COMPANY_ID,
          environment: "Production",
          buyer,
          items,
          payment_id,
        },
      },
      {
        tool: "melhor-envio/generate_label",
        params: (prev) => ({
          nfe_key: (prev[0]!.data as { chave: string }).chave,
        }),
      },
      {
        tool: "z-api/send_text",
        params: (prev) => ({
          phone,
          message: `NF-e emitida. Rastreio: ${(prev[1]!.data as { tracking_code: string }).tracking_code}`,
        }),
      },
    ],
  });

  return { ok: true };
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`brazilian-ecommerce listening on :${PORT}`);
});
