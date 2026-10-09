/**
 * What this agent prints, per locale: the runner's words for it and the
 * consent the titular reads before signing. Every key exists in both entries
 * (`npm run check`). The answers are read the same whatever the locale: the
 * approval question and the consent question take s, sim, y and yes.
 *
 * What goes to the API is not here: the consent's display name and intent
 * note are part of the consent the API records, not lines on this terminal.
 */
import { formatBRL, type LocaleTable } from "@codespar/agent-core";
import type { KitStrings } from "@codespar/agent-runtime";

const pt = {
  mandateWord: "mandato",
  receiptWord: "recibo",
  intro: 'Diga o que pagar ("pague a escola de outubro"). Ctrl+D ou "sair" encerra.',
  prompt: "> ",
  approveQuestion: "  Aprovar este pagamento? [s/N] ",
  uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita o pagamento)",
  notAuthorized: "o mandato não autoriza",

  consentHeader: "O mandato ainda não existe. Este é o consentimento que o titular assina (sandbox):",
  consentReplaces: (mandateId: string, state: string, file: string) => `Já existe um mandato em ${file}: ${mandateId}, ${state}. Este é o consentimento de um mandato novo, que passa a ser o do arquivo (sandbox):`,
  consentPreviousActive: "ativo na API",
  consentPreviousPaused: "pausado na API",
  consentPreviousRevoked: "revogado na API",
  consentPreviousExpired: "expirado",
  consentPreviousUnknown: "com estado que a API não respondeu",
  consentAgent: (agentId: string, purpose: string) => `  agente: ${agentId}    finalidade: ${purpose}`,
  consentCaps: (perTx: number, window: number, lifetime: number) => `  teto por pagamento: ${formatBRL(perTx, "pt-BR")}    teto do mês: ${formatBRL(window, "pt-BR")}    vitalício: ${formatBRL(lifetime, "pt-BR")}`,
  consentPayee: (name: string, alias: string) => `  favorecido: ${name} (${alias})`,
  consentValidity: (tokenExpiresAt: string) => `  validade: 1 ano    (o token do consentimento vale até ${tokenExpiresAt})`,
  consentQuestion: "  Você é o titular e autoriza este mandato? [s/N] ",
  consentSigned: (mandateId: string, consumerId: string) => `Mandato assinado: ${mandateId} (consumidor ${consumerId}).`,
  consentFunded: (amount: number, account: string, depositId: string) => `Sandbox creditado: ${formatBRL(amount, "pt-BR")} em ${account} (deposit ${depositId}).`,
  consentNotFunded: (code: string) => `Sandbox não creditado (${code}); o gasto de teste sob pix-consent não depende disso.`,
  consentSaved: (mandateId: string) => `mandato ${mandateId} salvo em .codespar/mandate.json`,
};

export const STRINGS: LocaleTable<typeof pt & KitStrings> = {
  "pt-BR": pt,
  en: {
    mandateWord: "mandate",
    receiptWord: "receipt",
    intro: 'Say what to pay ("pay the school for October"). Ctrl+D or "exit" ends.',
    prompt: "> ",
    approveQuestion: "  Approve this payment? [y/N] ",
    uncertainDispatch: "  outcome unknown on the rail; run `npm run resume` to reconcile (never repeat the payment)",
    notAuthorized: "the mandate does not authorize it",

    consentHeader: "The mandate does not exist yet. This is the consent the account holder signs (sandbox):",
    consentReplaces: (mandateId, state, file) => `${file} already holds a mandate: ${mandateId}, ${state}. This is the consent for a new one, which becomes the one in the file (sandbox):`,
    consentPreviousActive: "active on the API",
    consentPreviousPaused: "paused on the API",
    consentPreviousRevoked: "revoked on the API",
    consentPreviousExpired: "expired",
    consentPreviousUnknown: "in a state the API did not answer",
    consentAgent: (agentId, purpose) => `  agent: ${agentId}    purpose: ${purpose}`,
    consentCaps: (perTx, window, lifetime) => `  cap per payment: ${formatBRL(perTx, "en")}    cap per month: ${formatBRL(window, "en")}    lifetime: ${formatBRL(lifetime, "en")}`,
    consentPayee: (name, alias) => `  payee: ${name} (${alias})`,
    consentValidity: (tokenExpiresAt) => `  valid for: 1 year    (the consent token is valid until ${tokenExpiresAt})`,
    consentQuestion: "  Are you the account holder, and do you authorize this mandate? [y/N] ",
    consentSigned: (mandateId, consumerId) => `Mandate signed: ${mandateId} (consumer ${consumerId}).`,
    consentFunded: (amount, account, depositId) => `Sandbox credited: ${formatBRL(amount, "en")} to ${account} (deposit ${depositId}).`,
    consentNotFunded: (code) => `Sandbox not credited (${code}); the test spend under pix-consent does not depend on it.`,
    consentSaved: (mandateId) => `mandate ${mandateId} saved to .codespar/mandate.json`,
  },
};
