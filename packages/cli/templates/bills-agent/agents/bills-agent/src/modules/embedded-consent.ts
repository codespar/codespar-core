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
import { dirname, relative } from "node:path";
import type { ApiClient } from "@codespar/sdk";
import { ApiMandateStatusSource, MandateSchema, windowCap, type Locale, type Mandate, describeApiError } from "@codespar/agent-core";
import { STRINGS } from "../strings.js";

export interface ConsentOptions {
  api: ApiClient;
  example: Mandate;
  mandatePath: string;
  /** The language of the lines below. Default pt-BR. */
  locale?: Locale;
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

/** The words for what the API says of the mandate the file already holds; `unknown` is the API not answering. */
const PREVIOUS = {
  active: "consentPreviousActive",
  paused: "consentPreviousPaused",
  revoked: "consentPreviousRevoked",
  expired: "consentPreviousExpired",
  unknown: "consentPreviousUnknown",
} as const;

/** The mandate the file holds before this consent, when it holds one this kit can read. A file it cannot read is not a reason to stop a new consent. */
function previousMandate(path: string): Mandate | undefined {
  try {
    return loadLocalMandate(path);
  } catch {
    return undefined;
  }
}

export async function runEmbeddedConsent(options: ConsentOptions): Promise<Mandate> {
  const { api, example, say } = options;
  const text = STRINGS[options.locale ?? "pt-BR"];
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
        display_name: "bills-agent: contas do mês",
        intent_note: `Pagar as contas do mês aos favorecidos nomeados: ${example.beneficiaries.map((b) => b.name).join(", ")}.`,
      },
      surface: "partner",
    },
  });

  // A consent after a revocation is not a first one: the file holds the mandate it replaces, and the API says what became of it.
  const previous = previousMandate(options.mandatePath);
  const state = previous ? (await new ApiMandateStatusSource(api, now).check(previous.id)).status : undefined;

  say("");
  say(previous && state ? text.consentReplaces(previous.id, text[PREVIOUS[state]], relative(process.cwd(), options.mandatePath)) : text.consentHeader);
  say(text.consentAgent(example.agent_id, example.purpose));
  say(text.consentCaps(example.per_tx_cap_minor, windowCap(example), example.cap_minor));
  for (const b of example.beneficiaries) say(text.consentPayee(b.name, b.alias));
  say(text.consentValidity(init.expires_at));
  const yes = await options.confirm(text.consentQuestion);
  if (!yes) throw new Error("consent not authorized by the titular; nothing was created");

  // The consumer's "browser" is this terminal: the submit is the same call the hosted page makes,
  // plus the attestation the partner surface requires. Sandbox rails accept a placeholder token.
  const submitted = await api.post("/v1/consents/{token}/submit", {
    path: { token: init.token },
    body: {
      consumer_id: consumerId,
      rail: "pix-consent",
      provider_token: `sandbox-pix-consent-${consumerId}`,
      display_label: "bills-agent (sandbox)",
      attestation: { method: "in_person", asserted_at: Math.floor(now().getTime() / 1000), reference: "terminal" },
    },
  });

  const signed = submitted.mandate;
  const allowlist = signed["merchant_allowlist"];
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
    merchant_allowlist: allowlist,
    beneficiaries: example.beneficiaries.filter((b) => Array.isArray(allowlist) && allowlist.includes(b.payee)),
    status: "active",
    expires_at: new Date(Number(signed["expires_at"]) * 1000).toISOString(),
    signature: submitted.signature,
    canonical: signed,
    source: "consent",
  });

  mkdirSync(dirname(options.mandatePath), { recursive: true });
  writeFileSync(options.mandatePath, JSON.stringify(mandate, null, 2) + "\n", { mode: 0o600 });
  chmodSync(options.mandatePath, 0o600);
  say(text.consentSigned(mandate.id, mandate.consumer_id));

  await fundSandbox(api, mandate, say, options.locale);
  return mandate;
}

/** Best effort: the sandbox account is credited with one window's cap. A `pix-consent` source has no Celcoin account to credit, and the sandbox spend does not need one. */
export async function fundSandbox(api: ApiClient, mandate: Mandate, say: (line: string) => void, locale: Locale = "pt-BR"): Promise<void> {
  const text = STRINGS[locale];
  try {
    const funded = await api.post("/v1/test/fund", { body: { consumer_id: mandate.consumer_id, amount_minor: windowCap(mandate) } });
    say(text.consentFunded(funded.amount_minor, funded.account, funded.deposit_id));
  } catch (err) {
    const f = describeApiError(err);
    say(text.consentNotFunded(f.code));
  }
}
