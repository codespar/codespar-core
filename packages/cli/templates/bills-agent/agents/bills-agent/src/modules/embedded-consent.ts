/**
 * Module `embedded-consent`: the mandate is born at a consent the CONSUMER
 * authorizes. In the sandbox the kit runs the `partner` surface: it is the
 * partner's backend, the titular is at the keyboard, and the submit carries
 * an `in_person` attestation. That is what hands the kit the signed envelope
 * `{ mandate, signature }`, which `POST /v1/consumer-payments/execute`
 * presents on every spend. The `hosted` surface (a page the consumer opens)
 * returns the envelope to a `callback_url` a terminal kit does not have;
 * see docs/OPEN_QUESTIONS.md.
 *
 * With a test key and no `.codespar/mandate.json`, `npm start` runs this
 * first. The stored file carries the signature: mode 0600, never in the
 * bundle, never committed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiClient } from "@codespar/sdk";
import { MandateSchema, windowCap, type Mandate, describeApiError } from "@codespar/agent-core";

export interface ConsentOptions {
  api: ApiClient;
  example: Mandate;
  mandatePath: string;
  /** Where to write the lines the person reads. */
  say: (line: string) => void;
  /** Asks the titular to authorize. Returns true on yes. */
  confirm: (question: string) => Promise<boolean>;
  /** The consumer this mandate is for. Defaults to the example's. */
  consumerId?: string;
  now?: () => Date;
}

const YEAR_SECONDS = 365 * 24 * 3600;

export function loadLocalMandate(path: string): Mandate | undefined {
  if (!existsSync(path)) return undefined;
  return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export async function runEmbeddedConsent(options: ConsentOptions): Promise<Mandate> {
  const { api, example, say } = options;
  const now = options.now ?? (() => new Date());
  const consumerId = options.consumerId ?? example.consumer_id;

  const init = await api.post("/v1/consents/init", {
    body: {
      agent_id: example.agent_id,
      intent: {
        purpose: example.purpose,
        cap_minor: example.cap_minor,
        per_tx_cap_minor: example.per_tx_cap_minor,
        currency: "BRL",
        mandate_ttl_seconds: YEAR_SECONDS,
        merchant_allowlist: example.beneficiaries.map((b) => b.payee),
        merchant_pin_kind: "pix-key",
        ...(example.periodic_cap ? { periodic_cap: example.periodic_cap } : {}),
        display_name: "bills-agent: contas do mes",
        intent_note: `Pagar as contas do mes aos favorecidos nomeados: ${example.beneficiaries.map((b) => b.name).join(", ")}.`,
      },
      surface: "partner",
    },
  });

  say("");
  say("O mandato ainda nao existe. Este e o consentimento que o titular assina (sandbox):");
  say(`  agente: ${example.agent_id}    finalidade: ${example.purpose}`);
  say(`  teto por pagamento: ${example.per_tx_cap_minor} centavos    teto do mes: ${windowCap(example)} centavos    vitalicio: ${example.cap_minor} centavos`);
  for (const b of example.beneficiaries) say(`  favorecido: ${b.name} (${b.alias})`);
  say(`  validade: 1 ano    (o token do consentimento vale ate ${init.expires_at})`);
  const yes = await options.confirm("  Voce e o titular e autoriza este mandato? [s/N] ");
  if (!yes) throw new Error("consent not authorized by the titular; nothing was created");

  // The consumer's "browser" is this terminal: the submit is the same call the hosted page makes,
  // plus the attestation the partner surface requires. Sandbox rails accept a placeholder token.
  const submitted = (await api.request("post", "/v1/consents/{token}/submit" as never, {
    path: { token: init.token },
    body: {
      consumer_id: consumerId,
      rail: "pix-consent",
      provider_token: `sandbox-pix-consent-${consumerId}`,
      display_label: "bills-agent (sandbox)",
      attestation: { method: "in_person", asserted_at: Math.floor(now().getTime() / 1000), reference: "terminal" },
    },
  } as never)) as { mandate_id: string; mandate: Record<string, unknown>; signature: string };

  const signed = submitted.mandate;
  const mandate = MandateSchema.parse({
    id: submitted.mandate_id,
    version: 1,
    consumer_id: String(signed["consumer_id"]),
    agent_id: String(signed["agent_id"]),
    purpose: String(signed["purpose"]),
    currency: String(signed["currency"]),
    cap_minor: Number(signed["cap_minor"]),
    per_tx_cap_minor: Number(signed["per_tx_cap_minor"]),
    ...(signed["periodic_cap"] ? { periodic_cap: signed["periodic_cap"] } : {}),
    merchant_pin_kind: String(signed["merchant_pin_kind"]),
    merchant_allowlist: signed["merchant_allowlist"],
    beneficiaries: example.beneficiaries.filter((b) => (signed["merchant_allowlist"] as string[]).includes(b.payee)),
    status: "active",
    expires_at: new Date(Number(signed["expires_at"]) * 1000).toISOString(),
    signature: submitted.signature,
    canonical: signed,
    source: "consent",
  });

  mkdirSync(dirname(options.mandatePath), { recursive: true });
  writeFileSync(options.mandatePath, JSON.stringify(mandate, null, 2) + "\n", { mode: 0o600 });
  chmodSync(options.mandatePath, 0o600);
  say(`Mandato assinado: ${mandate.id} (consumidor ${mandate.consumer_id}).`);

  await fundSandbox(api, mandate, say);
  return mandate;
}

/** Best effort: the sandbox account is credited with one window's cap. A `pix-consent` source has no Celcoin account to credit, and the sandbox spend does not need one. */
export async function fundSandbox(api: ApiClient, mandate: Mandate, say: (line: string) => void): Promise<void> {
  try {
    const funded = await api.post("/v1/test/fund", { body: { consumer_id: mandate.consumer_id, amount_minor: windowCap(mandate) } });
    say(`Sandbox creditado: ${funded.amount_minor} centavos em ${funded.account} (deposit ${funded.deposit_id}).`);
  } catch (err) {
    const f = describeApiError(err);
    say(`Sandbox nao creditado (${f.code}); o gasto de teste sob pix-consent nao depende disso.`);
  }
}
