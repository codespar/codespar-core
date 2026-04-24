# brazilian-ecommerce

A full Brazilian e-commerce flow in ~50 lines of TypeScript. Companion code to the LinkedIn post and blog article on [codespar.dev](https://codespar.dev).

Two webhook endpoints orchestrate the whole order lifecycle end-to-end:

- **`POST /whatsapp`** — buyer sends an order via WhatsApp; server creates a Pix charge and replies with the QR copy-paste code.
- **`POST /pix-paid`** — Asaas fires this when the Pix settles; server issues the NF-e, generates the Melhor Envio label, and confirms the tracking code on WhatsApp.

Everything between those two endpoints — credential resolution, the asynchronous attach of the Pix QR on Asaas, retry-on-transient, logging — is handled by the SDK.

## Providers orchestrated

| Step | Provider | Tool |
|---|---|---|
| Create buyer record | Asaas | `asaas/create_customer` |
| Create Pix charge | Asaas | `asaas/create_payment` |
| Fetch QR code (async) | Asaas | `asaas/get_pix_qrcode` |
| Send QR on WhatsApp | Z-API | `z-api/send_text` |
| Issue NF-e (product) | NFe.io | `nfe-io/create_nfe` |
| Generate shipping label | Melhor Envio | `melhor-envio/generate_label` |
| Confirm tracking | Z-API | `z-api/send_text` |

## Prerequisites

1. **CodeSpar project with 4 providers connected** (green in `/dashboard/connections`): `asaas`, `nfe-io`, `melhor-envio`, `z-api`. See [docs/connect](https://codespar.dev/docs/connect) for the one-time setup (~5 minutes per provider).
2. **NFe.io company registered** — emitter CNPJ, regime tributário, CFOP defaults. Can be homologação (SEFAZ sandbox) for testing. Grab the `company_id` from the NFe.io dashboard.
3. **An API key** from `/dashboard/api-keys`. Use `csk_test_*` against a test project, `csk_live_*` against a live project.

## Run

```bash
cd examples/brazilian-ecommerce
npm install

export CODESPAR_API_KEY=csk_live_xxxxxxxxxxxxx
export NFE_COMPANY_ID=<your NFe.io company id>

npm start
```

The server listens on `:3000` (override with `PORT`).

### Smoke-test the charge endpoint

```bash
curl -X POST http://localhost:3000/whatsapp \
  -H "content-type: application/json" \
  -d '{
    "phone": "5521999999999",
    "name": "Cliente Demo",
    "cpf": "11144477735",
    "items": [
      { "sku": "SKU-001", "price": 49.90, "qty": 2 }
    ]
  }'
```

Expected: a real WhatsApp message with the Pix QR code lands on the phone. The response returns `{ payment_id }` — use it when simulating the webhook.

### Simulate Asaas firing `/pix-paid`

```bash
curl -X POST http://localhost:3000/pix-paid \
  -H "content-type: application/json" \
  -d '{
    "payment_id": "<from the previous step>",
    "phone": "5521999999999",
    "buyer": { ... },
    "items": [ { "sku": "SKU-001", "price": 49.90, "qty": 2 } ]
  }'
```

Expected: NF-e emitted, shipping label generated, tracking code delivered to WhatsApp.

## What this example is NOT

A full production e-commerce server. For that you also need:

- **Webhook signature verification.** Asaas signs every webhook payload. Verify before processing — otherwise anyone with the URL can trigger order flows.
- **Idempotency keys.** Asaas retries on 5xx; if your handler is not idempotent, you'll issue duplicate NF-es and double-charge shipping.
- **Product catalog lookup.** `items[].price` comes from the request body here. In production, look up price from your catalog + validate server-side.
- **Error recovery beyond SDK retry.** The SDK retries transient failures (rate limits, flaky DNS, the Asaas Pix QR async window). It does *not* know to roll back a half-completed flow — if step 2 succeeds but step 3 fails permanently, the NF-e was emitted but the label wasn't. That's a business decision: cancel the NF-e? Retry the label async? Notify an operator?

These are decisions that belong to the integrator, not to a 50-line starter.

## See also

- [`examples/latam-commerce-smoke/`](../latam-commerce-smoke) — standalone 4-provider smoke test. Validates conectividade pré-demo sem precisar de webhook real.
- [CodeSpar docs](https://codespar.dev/docs) — providers connected, how to add new ones, managed-tier governance (wallet + policy + audit).
- [The SDK on npm](https://www.npmjs.com/package/@codespar/sdk) — `@codespar/sdk`, MIT license, zero runtime deps besides `fetch`.
