/**
 * CodeSpar 4-provider commerce smoke test (standalone).
 *
 * Exercises the full LATAM commerce loop end-to-end against api.codespar.dev:
 *   Asaas       — create_customer → create_payment → get_pix_qrcode
 *   Z-API       — send_text (delivers the Pix QR to a WhatsApp number)
 *   NFe.io      — create_nfse (issues a dev-mode NFS-e)
 *   Melhor Envio — calculate_shipping (proves OAuth token is live)
 *
 * Prints pass/fail per step + the raw data returned. The idea is to
 * run this once, see green across 4 providers, and know the pipeline
 * is ready to ship. Not a persistent test suite.
 *
 * Usage:
 *   export CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx   # required
 *   export WHATSAPP_PHONE=5521995302656              # optional, defaults below
 *   export NFE_COMPANY_ID=<your company id>          # optional, SEFAZ homologação by default
 *   npx tsx smoke-test.ts
 *
 * Prerequisites:
 *   - API key created in dashboard (env of the key must match the
 *     project's env — e.g. a csk_test_* key only works against test
 *     projects).
 *   - All 4 provider connections green in that project's Auth Configs
 *     (`asaas`, `nfe-io`, `melhor-envio`, `z-api`). For Melhor Envio
 *     this means the OAuth flow has been completed at least once.
 *   - An NFe.io company registered and reachable via the project's
 *     connection. If you don't have one, leave NFE_COMPANY_ID unset
 *     and the script uses the SEFAZ homologação fixture.
 *
 * The script continues past failures — so one broken step doesn't
 * hide problems in the others. Expect 6 ✅ on a healthy pipeline.
 */

import { CodeSpar } from "@codespar/sdk";
import type { ToolResult } from "@codespar/types";

// ────────────────────────────────────────────────────────────────
// Config — all overridable via env
// ────────────────────────────────────────────────────────────────

const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE || "5521995302656";
const NFE_COMPANY_ID =
  process.env.NFE_COMPANY_ID || "fd67cc271c6f47019157def639c1dc6d"; // SEFAZ homologação fixture
const SENDER_CEP = "01310100"; // São Paulo / SP (origin for shipping)
const BUYER_CEP = "20040002"; // Rio de Janeiro / RJ (destination)

// Dummy buyer — CPF válido no dígito verificador
const BUYER = {
  name: "Cliente Demo CodeSpar",
  cpf: "11144477735",
  email: "cliente@example.com",
};

const CODESPAR_API_KEY = process.env.CODESPAR_API_KEY;
if (!CODESPAR_API_KEY) {
  console.error(
    "❌ CODESPAR_API_KEY not set. Create one at " +
      "https://codespar.dev/dashboard/api-keys then:\n" +
      "   export CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx",
  );
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────
// Pretty logger
// ────────────────────────────────────────────────────────────────

let stepNum = 0;
function header(title: string): void {
  stepNum += 1;
  const bar = "─".repeat(60);
  console.log(`\n${bar}\n▶ Step ${stepNum} — ${title}\n${bar}`);
}

function ok(msg: string, payload?: unknown): void {
  console.log(`  ✅ ${msg}`);
  if (payload !== undefined)
    console.log("    ", JSON.stringify(payload, null, 2).replace(/\n/g, "\n     "));
}

function fail(msg: string, payload?: unknown): void {
  console.log(`  ❌ ${msg}`);
  if (payload !== undefined)
    console.log("    ", JSON.stringify(payload, null, 2).replace(/\n/g, "\n     "));
}

function assertOk(result: ToolResult, label: string): boolean {
  if (result.success) {
    ok(`${label} (success)`, result.data);
    return true;
  }
  fail(`${label} failed`, { error: result.error, data: result.data });
  return false;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀 CodeSpar 4-provider commerce smoke test");
  console.log(`   key prefix: ${CODESPAR_API_KEY!.slice(0, 12)}...`);
  console.log(`   whatsapp:   +${WHATSAPP_PHONE}`);
  console.log(`   nfe.io:     ${NFE_COMPANY_ID}`);

  const cs = new CodeSpar({ apiKey: CODESPAR_API_KEY });
  // user_id is audit-only since migration 0028 (connections are
  // project-scoped, not user-scoped). Any stable string works;
  // using a fresh per-run id keeps the session log readable.
  const session = await cs.create(`smoke-${Date.now()}`);
  console.log(`   session:    ${session.id}\n`);

  // ── 1. Asaas: create customer ────────────────────────────────
  header("Asaas — create_customer");
  // Asaas expects BR mobilePhone as DDD + number only (11 digits).
  // Country-coded E.164 (5521…) trips an "Número de telefone
  // incorreto" notification email — harmless but noisy.
  const asaasMobilePhone = WHATSAPP_PHONE.startsWith("55")
    ? WHATSAPP_PHONE.slice(2)
    : WHATSAPP_PHONE;
  const customerResult = await session.execute("asaas/create_customer", {
    name: BUYER.name,
    cpfCnpj: BUYER.cpf,
    email: BUYER.email,
    mobilePhone: asaasMobilePhone,
  });
  const customerOk = assertOk(customerResult, "customer created");
  const customerId = customerOk ? (customerResult.data as { id: string }).id : null;

  // ── 2. Asaas: create Pix payment ─────────────────────────────
  let paymentId: string | null = null;
  if (customerId) {
    header("Asaas — create_payment (Pix)");
    const dueDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const paymentResult = await session.execute("asaas/create_payment", {
      customer: customerId,
      billingType: "PIX",
      value: 100.0,
      dueDate,
      description: "Smoke test CodeSpar",
    });
    if (assertOk(paymentResult, "Pix payment created")) {
      paymentId = (paymentResult.data as { id: string }).id;
    }
  }

  // ── 3. Asaas: get Pix QR code ────────────────────────────────
  // The Pix QR is attached asynchronously to the payment after create.
  // Retrying with short backoff handles the race without blocking the
  // rest of the smoke. 3 attempts × 1s is typically overkill; QR
  // usually materializes in <500ms.
  let pixPayload: string | null = null;
  if (paymentId) {
    header("Asaas — get_pix_qrcode (with retry on async QR materialization)");
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const qrResult = await session.execute("asaas/get_pix_qrcode", {
        id: paymentId,
      });
      if (qrResult.success) {
        pixPayload = (qrResult.data as { payload: string }).payload;
        assertOk(qrResult, `Pix QR fetched (attempt ${attempt})`);
        break;
      }
      if (attempt < maxAttempts) {
        console.log(`  ⏳ attempt ${attempt} failed — backing off 1s and retrying`);
        await new Promise((r) => setTimeout(r, 1000));
      } else {
        fail(`Pix QR still unavailable after ${maxAttempts} attempts`, {
          error: qrResult.error,
          data: qrResult.data,
        });
      }
    }
  }

  // ── 4. Z-API: send WhatsApp with QR ──────────────────────────
  if (pixPayload) {
    header("Z-API — send_text (WhatsApp with Pix QR)");
    const sendResult = await session.execute("z-api/send_text", {
      phone: WHATSAPP_PHONE,
      message:
        `🧪 Smoke test CodeSpar\n\n` +
        `💰 Pix R$ 100,00\n\n` +
        `${pixPayload}`,
    });
    assertOk(sendResult, "WhatsApp sent");
  }

  // ── 5. NFe.io: create NFS-e (Development env) ────────────────
  let nfseId: string | null = null;
  header("NFe.io — create_nfse (Development mode)");
  const nfseResult = await session.execute("nfe-io/create_nfse", {
    company_id: NFE_COMPANY_ID,
    cityServiceCode: "101",
    description: `Smoke test CodeSpar — ${new Date().toISOString()}`,
    servicesAmount: 100.0,
    borrower: {
      federalTaxNumber: Number(BUYER.cpf),
      name: BUYER.name,
      email: BUYER.email,
      address: {
        country: "BRA",
        postalCode: BUYER_CEP,
        street: "Av. Rio Branco",
        number: "100",
        district: "Centro",
        city: { code: "3304557", name: "Rio de Janeiro" },
        state: "RJ",
      },
    },
  });
  if (assertOk(nfseResult, "NFS-e issued")) {
    nfseId = (nfseResult.data as { id: string }).id;
  }

  // ── 6. Melhor Envio: calculate shipping ──────────────────────
  header("Melhor Envio — calculate_shipping");
  const shippingResult = await session.execute(
    "melhor-envio/calculate_shipping",
    {
      from: { postal_code: SENDER_CEP },
      to: { postal_code: BUYER_CEP },
      products: [
        {
          width: 16,
          height: 6,
          length: 24,
          weight: 0.5,
          quantity: 1,
          insurance_value: 100,
        },
      ],
    },
  );
  assertOk(shippingResult, "shipping quote returned");

  // ── Summary ──────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("📊 Summary");
  console.log("═".repeat(60));
  console.log(`   Asaas customer:  ${customerId ?? "—"}`);
  console.log(`   Pix payment:     ${paymentId ?? "—"}`);
  console.log(`   QR payload sent: ${pixPayload ? "yes" : "no"}`);
  console.log(`   NFS-e id:        ${nfseId ?? "—"}`);
  console.log(`   session:         ${session.id}`);
  console.log("");

  await session.close().catch(() => {
    /* best effort — server-side session GCs anyway */
  });
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err);
  process.exit(1);
});
