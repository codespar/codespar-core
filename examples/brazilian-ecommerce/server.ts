/**
 * Brazilian e-commerce in ~50 lines — the companion code to the LinkedIn
 * post at https://codespar.dev/blog/brazilian-ecommerce-50-lines.
 *
 * Two webhook endpoints:
 *
 *   POST /whatsapp   — buyer sends an order on WhatsApp; server creates a
 *                      Pix charge via `session.charge()` and replies with
 *                      the QR copy-paste code.
 *
 *   POST /pix-paid   — Asaas fires this when the Pix settles; server issues
 *                      the NF-e, generates the shipping label, and confirms
 *                      the tracking code on WhatsApp.
 *
 * Everything in between — credential resolution, provider-specific quirks,
 * retry on async state (the Pix QR attach), failover across PSPs, and
 * logging — is handled by the SDK + meta-tool router.
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
 *   - For Asaas: pre-create the buyer via `asaas/create_customer` and pass
 *     the returned id via `metadata.customer_id`. Cache it per CPF so the
 *     same buyer doesn't trigger a fresh customer row on every order.
 *
 * Not in scope for a ~50-line demo (handle these in production):
 *   - Webhook signature verification (Asaas signs payloads — always verify)
 *   - Idempotency keys on the webhook (Asaas retries on 5xx)
 *   - Product catalog lookup (price comes from the request body here)
 *   - Error recovery beyond the SDK's built-in retry (rollback, compensation)
 *
 * Why this example uses meta-tools for both the Pix and NF-e flows:
 *   - `codespar_charge` (NEW 2026-05-01) routes to the best inbound-charge
 *     PSP for the rail (Pix BRL → Asaas; failover to MP / iugu / Stone).
 *     The agent passes a neutral `{amount, currency, method, buyer}` shape
 *     and the router returns a uniform `{id, pix_copy_paste}` payload.
 *   - `codespar_invoice` defaults to NFS-e (services). This example sells
 *     products, so the `/pix-paid` flow opts into NF-e via `rail: "nfe"`.
 *     Operators MUST have the NFe.io fiscal setup in place (A1 cert +
 *     state tax registration + per-item ICMS classification) — without it
 *     NFe.io 404s with "company doesn't have state tax" and the call
 *     surfaces the same error to the caller. NFS-e remains the default
 *     for tenants without that setup; opt in explicitly here.
 *
 * The /pix-paid flow is now FULLY meta-tool driven: `codespar_invoice` +
 * `codespar_ship` + `codespar_notify` — no direct provider calls remain.
 * The `melhor-envio/generate_label` → `codespar_ship` swap landed on
 * 2026-05-01 alongside the new shipping rails (domestic-label /
 * domestic-quote / domestic-track on Melhor Envio).
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
// charge via codespar_charge and replies with the QR copy-paste code.
//
// `cpfToCustomerId` is a sketch of the per-buyer customer cache the
// integrator owns. Asaas (and most LATAM PSPs) require a pre-created
// customer reference; this example keeps the cache in-memory for clarity
// — production code persists it to Postgres / Redis keyed off CPF.
// ─────────────────────────────────────────────────────────────────────
const cpfToCustomerId = new Map<string, string>();

async function ensureAsaasCustomerId(
  session: Awaited<ReturnType<typeof cs.create>>,
  args: { name: string; cpf: string; phone: string },
): Promise<string> {
  const cached = cpfToCustomerId.get(args.cpf);
  if (cached) return cached;
  const result = await session.execute("asaas/create_customer", {
    name: args.name,
    cpfCnpj: args.cpf,
    mobilePhone: args.phone,
  });
  if (!result.success) {
    throw new Error(`asaas/create_customer failed: ${result.error}`);
  }
  const id = (result.data as { id: string }).id;
  cpfToCustomerId.set(args.cpf, id);
  return id;
}

app.post<{
  Body: { phone: string; name: string; cpf: string; items: Item[] };
}>("/whatsapp", async (req) => {
  const { phone, name, cpf, items } = req.body;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const session = await cs.create(phone);

  const customerId = await ensureAsaasCustomerId(session, { name, cpf, phone });

  // We call codespar_charge via session.execute() rather than the typed
  // session.charge() because Asaas requires a pre-created customer id
  // passed through `metadata.customer_id` — the typed wrapper doesn't
  // surface metadata. When the active PSP doesn't need an upstream
  // reference (Mercado Pago, iugu pull buyer info directly), drop
  // metadata and call session.charge() instead.
  const raw = await session.execute("codespar_charge", {
    amount: total,
    currency: "BRL",
    method: "pix",
    description: `Pedido — ${items.map((i) => i.sku).join(", ")}`,
    buyer: { name, document: cpf, phone },
    metadata: { customer_id: customerId },
  });
  if (!raw.success) {
    throw new Error(`codespar_charge failed: ${raw.error}`);
  }
  const charge = raw.data as { id: string; pix_copy_paste?: string };

  await session.execute("codespar_notify", {
    recipient: phone,
    message: `Seu Pix: ${charge.pix_copy_paste ?? "(QR ainda processando — tente novamente em instantes)"}`,
  });

  return { payment_id: charge.id };
});

// ─────────────────────────────────────────────────────────────────────
// POST /pix-paid — Asaas webhook fires when the Pix settles. Emit the
// NF-e, generate the Melhor Envio label, confirm on WhatsApp.
// ─────────────────────────────────────────────────────────────────────
app.post<{
  Body: {
    payment_id: string;
    phone: string;
    buyer: { name?: string; document?: string; address: { postal_code: string } };
    items: Item[];
  };
}>("/pix-paid", async (req) => {
  const { payment_id, phone, buyer, items } = req.body;
  const session = await cs.create(phone);

  await loop(session, {
    steps: [
      {
        tool: "codespar_invoice",
        params: {
          // NF-e (products) is opt-in — codespar_invoice defaults to
          // NFS-e (services) for the broad services-first ICP. Stamp
          // `rail: "nfe"` to land on `nfe-io:create_nfe` instead.
          // Tenant must have the A1 cert + state tax + ICMS setup;
          // missing setup surfaces NFe.io's 404 directly.
          rail: "nfe",
          operation: "sale",
          buyer,
          products: items.map((i) => ({
            description: i.sku,
            quantity: i.qty,
            unit_price: i.price,
            // NCM is the BR product classification code — the operator
            // supplies one per SKU (8-digit string). The placeholder
            // here keeps the demo shape intact; production code looks
            // it up from the catalog.
            ncm: "12345678",
          })),
          companyId: COMPANY_ID,
          metadata: { payment_id },
        },
      },
      {
        tool: "codespar_ship",
        params: (prev) => ({
          // codespar_ship × domestic-label routes to Melhor Envio
          // create_shipment. The neutral {origin, destination, items}
          // shape lets the router pick the cheapest carrier per
          // request; nfe_key is required for declared-value shipments
          // and rides through metadata.
          action: "label" as const,
          origin: { postal_code: "01310-100" }, // operator-supplied default
          destination: buyer.address,
          items: items.map((i) => ({ weight_g: 500, quantity: i.qty })),
          service_level: "cheapest" as const,
          metadata: {
            nfe_key: (prev[0]!.data as { access_key: string }).access_key,
          },
        }),
      },
      {
        tool: "codespar_notify",
        params: (prev) => ({
          recipient: phone,
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
