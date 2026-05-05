# brazilian-ecommerce

A full Brazilian e-commerce flow in ~50 lines of TypeScript. Companion code to the LinkedIn post and blog article on [codespar.dev](https://codespar.dev).

Two webhook endpoints orchestrate the whole order lifecycle end-to-end:

- **`POST /whatsapp`** — buyer sends an order via WhatsApp; server creates a Pix charge and replies with the QR copy-paste code.
- **`POST /pix-paid`** — Asaas fires this when the Pix settles; server issues the NF-e, generates the Melhor Envio label, and confirms the tracking code on WhatsApp.

Everything between those two endpoints — credential resolution, the asynchronous attach of the Pix QR on Asaas, retry-on-transient, logging — is handled by the SDK.

## Providers orchestrated

The `/pix-paid` flow is **fully meta-tool driven**. The `/whatsapp`
flow is meta-tool driven *except* for the buyer-record step — Asaas
requires a pre-created customer reference, and the typed `charge()`
wrapper does not yet surface the `metadata` field needed to attach
the buyer record back, so the canonical `asaas/create_customer` call
stays in place for now.

| Step | Provider | Tool |
|---|---|---|
| Create buyer record | Asaas | `asaas/create_customer` |
| Create Pix charge (with failover) | Asaas → MP → iugu → Stone | `codespar_charge` |
| Send QR on WhatsApp | Z-API | `codespar_notify` |
| Issue NF-e (product) | NFe.io | `codespar_invoice` (`rail: "nfe"`) |
| Generate shipping label | Melhor Envio | `codespar_ship` (`action: "label"`) |
| Confirm tracking | Z-API | `codespar_notify` |

The flow is now **fully meta-tool driven** — every step routes through a
`codespar_*` rail with failover, idempotency, and provider-neutral
shapes. No direct `provider/tool` calls remain in `/pix-paid`.

The Pix-charge step uses the `codespar_charge` meta-tool — the router
picks the highest-scored connected PSP and falls over to the next when
one is down. Asaas is the default for the demo; with MP / iugu / Stone
also connected, an Asaas outage no longer breaks the order.

The NF-e step uses `codespar_invoice` with `rail: "nfe"` to opt into
the product-invoice rail (the meta-tool defaults to NFS-e — services).
Operators MUST have the full NFe.io fiscal setup in place (A1 cert +
state tax registration + per-item ICMS classification) — without it
NFe.io 404s with "company doesn't have state tax" and the call
surfaces the same error to the caller. NFS-e tenants drop the
`rail: "nfe"` field and let the meta-tool default land on NFS-e.

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

## Why `codespar_charge` for Pix and `codespar_invoice` for NF-e

CodeSpar ships **meta-tools** (`codespar_charge`, `codespar_pay`,
`codespar_invoice`, `codespar_notify`) that route to the best provider
per call with failover + idempotency. This example uses:

1. **`codespar_charge`** for the `/whatsapp` flow. NEW meta-tool name
   (2026-05-01): inbound charges (the buyer pays the merchant). The
   router fails over Asaas → Mercado Pago → iugu → Stone within the
   same Pix BRL rail, so an outage on any single PSP doesn't break the
   order. The agent passes a neutral `{amount, currency, method, buyer}`
   shape and gets back a uniform `{id, pix_copy_paste}` payload.
   Distinct from `codespar_pay`, which routes to OUTBOUND transfers
   (Asaas `create_transfer`).
2. **`codespar_invoice` with `rail: "nfe"`** for the `/pix-paid` flow.
   The meta-tool defaults to **NFS-e** (services); product-selling
   agents pass `rail: "nfe"` to land on NFe.io's NF-e endpoint. The
   tenant must have the full NFe.io fiscal setup (A1 cert + state tax
   registration + per-item ICMS classification) — missing setup
   surfaces NFe.io's 404 directly. Services-first agents drop the
   rail field and the meta-tool defaults to NFS-e.

The `z-api/send_text` → `codespar_notify` swap shipped 2026-05-01;
`server.ts` uses the meta-tool variant directly:

```ts
{ tool: "codespar_notify", params: { recipient: phone, message: "..." } }
```

Both shapes work — the SDK's `session.execute()` accepts canonical and
meta-tool names through the same surface — but the example commits to
the meta-tool form so failover and idempotency are on by default.

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
