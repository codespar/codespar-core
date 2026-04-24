# latam-commerce-smoke

Standalone 4-provider end-to-end smoke test against `api.codespar.dev`. Validates that the full LATAM commerce pipeline responds:

- **Asaas** — creates customer → Pix charge → retrieves QR payload
- **Z-API** — sends a WhatsApp message carrying the Pix QR
- **NFe.io** — issues a dev-mode NFS-e
- **Melhor Envio** — returns shipping rates

Use this to verify a fresh project is fully onboarded before demos, CI health checks, or just to catch provider outages early.

## Prerequisites

1. An API key in the Dashboard: https://codespar.dev/dashboard/api-keys
   - The key's env (`csk_test_*` or `csk_live_*`) must match the env of the project you're testing.
2. All 4 providers connected (green status in `/dashboard/connections`):
   - `asaas`, `nfe-io`, `melhor-envio`, `z-api`
3. An NFe.io company registered. If you don't have one, leave `NFE_COMPANY_ID` unset — it defaults to the SEFAZ homologação fixture that CodeSpar uses for internal demos.

## Run

```bash
cd examples/latam-commerce-smoke
npm install

export CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx
# Optional overrides:
#   export WHATSAPP_PHONE=5521995302656
#   export NFE_COMPANY_ID=<your company id>

npm run smoke
```

## What a healthy run looks like

```
🚀 CodeSpar 4-provider commerce smoke test
────────────────────────────────────────────
▶ Step 1 — Asaas — create_customer        ✅
▶ Step 2 — Asaas — create_payment (Pix)   ✅
▶ Step 3 — Asaas — get_pix_qrcode          ✅
▶ Step 4 — Z-API — send_text               ✅
▶ Step 5 — NFe.io — create_nfse            ✅
▶ Step 6 — Melhor Envio — calculate_shipping ✅

📊 Summary
   Asaas customer:  cus_000007856824
   Pix payment:     pay_z8rwa1qnr0twili5
   QR payload sent: yes
   NFS-e id:        69eabbd0ae8c9a0f50e7f23d
```

And a real WhatsApp lands on `WHATSAPP_PHONE` carrying the Pix QR payload — paste into any bank app to settle the charge in the Asaas sandbox.

## What this example does NOT do

- No polling for payment confirmation (that's the webhook path).
- No Melhor Envio shipment creation / label generation — `calculate_shipping` alone is enough to confirm the OAuth token is live. Full label flow would add `create_shipment → checkout_cart → generate_label → print_label`.
- No cleanup. The sandbox customer, payment, NFS-e, and shipping quote stay in the providers' systems. They're test data and auto-expire.
