/**
 * What this agent prints, per locale: the runner's words for it, the lines an
 * execution reads as, the one message per outcome the debtor receives, and the
 * refusal details the envelope writes. Every key exists in both entries (`npm
 * run check`).
 *
 * The envelope's details and the agreement statuses are read by the model too,
 * as tool results; the model explains them in the reply language whatever the
 * locale. The reason CODES next to them (`outside_envelope`, `outside_hours`)
 * are machine words and are the same in every locale.
 */
import type { LocaleTable } from "@codespar/agent-core";
import type { KitStrings } from "@codespar/agent-runtime";

const pt = {
  mandateWord: "política",
  receiptWord: "registro",
  intro: 'Você é o pagador. Diga algo ("oi, recebi a mensagem sobre o acordo do pedido 1042"). Ctrl+D ou "sair" encerra.',
  prompt: "pagador> ",
  approveQuestion: "  [operador] Aprovar a emissão desta cobrança? [s/N] ",
  uncertainDispatch: "  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a emissão)",
  notAuthorized: "a política não autoriza",
  waitingForPayer: (round: number) => `  aguardando o pagador... (${round} consultas)`,

  agreementOf: (debtor: string, alias: string) => `acordo de ${debtor} (${alias})`,
  instalmentLine: (instalment: number, count: number, amount: string, due: string) => `parcela ${instalment}/${count}: ${amount}, vence ${due}`,
  chargeLine: (instalment: number) => `cobrança ${instalment}`,

  toldSettled: (chargeIds: string) => `Recebemos, acordo quitado. Obrigado! (${chargeIds})`,
  toldExpired: "A cobrança venceu sem pagamento. Se quiser, emito uma nova dentro das mesmas condições.",
  toldCancelled: "A cobrança foi cancelada. Nada foi pago.",
  toldAmbiguous: "A cobrança deste acordo já foi emitida e estamos conferindo a situação dela. Não pague de novo; te aviso assim que estiver conferida.",
  toldFailed: (reason: string | undefined) => `Não consegui emitir a cobrança (${reason ?? "falha no trilho"}). Nada foi cobrado.`,
  toldDenied: (reason: string | undefined) => `Não posso emitir nesses termos (${reason ?? "recusado"}).`,
  toldUndecided: (state: string) => `A proposta expirou sem decisão (${state}).`,

  statusSettled: "quitado",
  statusIssued: "cobrança emitida, aguardando pagamento",
  statusUnreconciled: "cobrança emitida, em conferência: não emitir outra",
  statusOpen: "em aberto",

  envelopeTooManyInstalments: (count: number, max: number) => `${count} parcelas; o envelope permite até ${max}`,
  envelopeBelowFloor: (total: number, pct: number, principal: number, maxPct: number, floor: number) =>
    `total ${total} é ${pct}% abaixo do principal ${principal}; o desconto máximo é ${maxPct}% (piso ${floor})`,
  envelopeAbovePrincipal: (total: number, principal: number) => `total ${total} acima do principal ${principal}; não se cobra mais do que se deve`,
  envelopeInstalmentTooSmall: (amount: number, min: number) => `parcela de ${amount} abaixo do mínimo ${min}`,
  envelopeNoDueDate: (instalment: number) => `parcela ${instalment} sem vencimento`,
  envelopeDuePassed: (due: string, instalment: number, today: string) => `vencimento ${due} da parcela ${instalment} já passou (hoje é ${today})`,
  envelopeDueOutsideWindow: (due: string, instalment: number, days: number, last: string) => `vencimento ${due} da parcela ${instalment} fora da janela de ${days} dias (até ${last})`,
  envelopeDueOutOfOrder: (instalment: number) => `parcela ${instalment} vence antes da anterior`,
};

export const STRINGS: LocaleTable<typeof pt & KitStrings> = {
  "pt-BR": pt,
  en: {
    mandateWord: "policy",
    receiptWord: "record",
    intro: 'You are the payer. Say something ("hi, I got the message about the agreement for order 1042"). Ctrl+D or "exit" ends.',
    prompt: "payer> ",
    approveQuestion: "  [operator] Approve issuing this charge? [y/N] ",
    uncertainDispatch: "  outcome unknown on the rail; run `npm run resume` to reconcile (never repeat the issuance)",
    notAuthorized: "the policy does not authorize it",
    waitingForPayer: (round) => `  waiting for the payer... (${round} looks)`,

    agreementOf: (debtor, alias) => `agreement of ${debtor} (${alias})`,
    instalmentLine: (instalment, count, amount, due) => `instalment ${instalment}/${count}: ${amount}, due ${due}`,
    chargeLine: (instalment) => `charge ${instalment}`,

    toldSettled: (chargeIds) => `Payment received, the agreement is settled. Thank you! (${chargeIds})`,
    toldExpired: "The charge reached its due date unpaid. If you like, I can issue a new one on the same terms.",
    toldCancelled: "The charge was cancelled. Nothing was paid.",
    toldAmbiguous: "The charge for this agreement was already issued and we are checking where it stands. Do not pay again; I will let you know as soon as it is checked.",
    toldFailed: (reason) => `I could not issue the charge (${reason ?? "rail failure"}). Nothing was charged.`,
    toldDenied: (reason) => `I cannot issue on those terms (${reason ?? "refused"}).`,
    toldUndecided: (state) => `The proposal expired without a decision (${state}).`,

    statusSettled: "settled",
    statusIssued: "charge issued, awaiting payment",
    statusUnreconciled: "charge issued, under review: do not issue another",
    statusOpen: "open",

    envelopeTooManyInstalments: (count, max) => `${count} instalments; the envelope allows up to ${max}`,
    envelopeBelowFloor: (total, pct, principal, maxPct, floor) => `total ${total} is ${pct}% below the principal ${principal}; the maximum discount is ${maxPct}% (floor ${floor})`,
    envelopeAbovePrincipal: (total, principal) => `total ${total} above the principal ${principal}; nobody is charged more than they owe`,
    envelopeInstalmentTooSmall: (amount, min) => `instalment of ${amount} below the minimum ${min}`,
    envelopeNoDueDate: (instalment) => `instalment ${instalment} has no due date`,
    envelopeDuePassed: (due, instalment, today) => `due date ${due} of instalment ${instalment} has passed (today is ${today})`,
    envelopeDueOutsideWindow: (due, instalment, days, last) => `due date ${due} of instalment ${instalment} is outside the ${days}-day window (until ${last})`,
    envelopeDueOutOfOrder: (instalment) => `instalment ${instalment} falls due before the previous one`,
  },
};
