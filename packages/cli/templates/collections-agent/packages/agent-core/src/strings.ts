/**
 * The strings every agent shares, in each locale: the approval path's lines
 * (the batch gesture, the per-line question's hint, the waits), the words of
 * an execution's description, how a payable instrument is shown, and the
 * operator's lines on the WhatsApp channel. A kit's own words are in its
 * kit's `strings`.
 *
 * DISPLAY ONLY. What a person may ANSWER is not here and does not depend on
 * the locale: `[s/N]` takes s, sim, y and yes in both, and the batch gesture
 * takes todas / all, todas exceto / all except, nenhuma / none in both
 * (`parseBatchGesture`). A prompt shown in English and answered in Portuguese
 * decides exactly what the same answer decides under a Portuguese prompt.
 */
import type { LocaleTable } from "./locale.js";

const pt = {
  // How an execution reads on the console.
  execution: "execução",
  totalByCore: "total (calculado pelo core)",
  escalatedBy: "escalado por",
  blocked: (reasons: string, notAuthorized: string) => `bloqueado: ${reasons} — ${notAuthorized}; não há o que aprovar`,
  replayedSettlement: "já estava pago: a API respondeu com um pagamento anterior desta mesma tentativa; esta execução não moveu dinheiro",

  // The approval path at the keyboard.
  onlyDeny: "  (o único desfecho possível é negar; aperte Enter)",
  leftAwaiting: "  deixado em awaiting_approval (rode de novo com --approve ou --deny)",
  afterLooks: (rounds: number, seconds: number, timedOut: boolean) =>
    ` após ${rounds} consulta(s), ${seconds}s${timedOut ? " (tempo esgotado; `npm run poll` continua de onde parou)" : ""}`,
  banner: (name: string, version: string, mode: string, rail: string, mandateWord: string, mandateId: string) => `${name} ${version} — approval: ${mode} — trilho: ${rail} — ${mandateWord} ${mandateId}`,
  bundleAt: (runId: string, dir: string) => `run ${runId} — bundle em ${dir}`,

  // The batch gesture: one question for a whole list.
  batchHeader: (ref: string, label: string, count: number, total: string, hash: string) => `  lote ${ref} — ${label}: ${count} linha(s), total ${total}, batch_hash ${hash}…`,
  batchAlreadySettled: " (já paga; não roda de novo)",
  batchInProgress: " (em andamento; não roda de novo)",
  batchAttemptConflict: " (tentativa presa a outro pagamento; não roda de novo)",
  batchQuestion: "  Aprovar a lista? [todas / todas exceto 3,7 / nenhuma] ",
  batchUnreadable: (count: number) => `  não entendi; responda todas, todas exceto <números de 1 a ${count}> ou nenhuma`,
  batchApprovedAll: "  -> lista aprovada inteira",
  batchDeniedAll: "  -> lista negada inteira",
  batchApprovedExcept: (positions: string) => `  -> lista aprovada exceto ${positions}`,

  // A payable instrument, on the terminal and on WhatsApp.
  instalmentOf: (instalment: number, count: number) => `Parcela ${instalment}/${count}: `,
  dueOn: (date: string) => `, vence ${date}`,
  chargeRef: (chargeId: string) => ` — cobrança ${chargeId}`,
  pixCopyPaste: "Pix copia e cola:",
  boletoLine: "Ou pelo boleto, linha digitável:",

  // The collection-hours rule: the envelope refuses to draft outside it, the channel refuses to speak.
  outsideCollectionHours: (window: string, timezone: string, clock: string) => `fora do horário de cobrança (${window} ${timezone}); agora são ${clock}`,

  // The scenario runner.
  scenarioReply: (text: string) => `agente: ${text}`,
  scenarioOk: (cycleSeconds: number | null | undefined, dir: string) =>
    `== ok — ${cycleSeconds === undefined ? "" : cycleSeconds === null ? "sem ciclo medido — " : `${cycleSeconds}s — `}bundle em ${dir}`,

  // The WhatsApp channel, on the operator's console. None of these reach the person.
  waBanner: (name: string, version: string, backend: string, mode: string, rail: string, mandateWord: string, mandateId: string) =>
    `${name} ${version} — canal: whatsapp (${backend}) — approval: ${mode} — trilho: ${rail} — ${mandateWord} ${mandateId}`,
  waTapIgnored: (rule: string, detail: string) => `  [whatsapp] toque ignorado (${rule}): ${detail}`,
  waRefused: (rule: string, detail: string) => `  [whatsapp] recusado (${rule}): ${detail}`,
  waRefusedByBackend: (rule: string, detail: string) => `  [whatsapp] recusado pelo backend (${rule}): ${detail}`,
  waDeliveryFailed: (messageId: string, codes: string, told: string | undefined) =>
    `  [operador] ENTREGA FALHOU da mensagem ${messageId} (${codes})${told ? ` — era o aviso de ${told}: a pessoa NÃO foi avisada` : ""}`,
  waShop: "loja:",
  waTap: (title: string) => `[toque: ${title}]`,
  waTapIgnoredMark: (rule: string) => ` (ignorado: ${rule})`,
  waNotSent: (rule: string) => `(não enviada: ${rule})`,
  waCopyPaste: "[copia e cola]",
  waQrImage: "[imagem: QR Pix]",
  waYou: "  │ você> ",
  waEmulatorOpen: "  ┌─ WhatsApp (dyvit-wa-sim, emulador local da Cloud API — sem rede externa, sem conta Meta)",
  waEmulatorClosed: "  └─ fim da conversa",
  waConversationSummary: (log: string, received: number | undefined, sent: number, refused: number) =>
    `conversa em ${log} — ${received === undefined ? "" : `${received} recebida(s), `}${sent} enviada(s)${refused ? `, ${refused} recusada(s)` : ""}`,
  waSimulatedCost: (total: string, currency: string) => `custo simulado desta conversa nas regras da Meta: ${total} ${currency} (conta do emulador, não nossa)`,

  // `poll --channel whatsapp`.
  pollNoSubject: (conversation: string) =>
    `a conversa ${conversation} não declara subject: não dá para dizer quais execuções são dela, e mandar o desfecho de outra pessoa nesta conversa é exatamente o que a regra de sigilo proíbe`,
  pollNothingWaiting: (conversation: string) => `nada aguardando pagador em ${conversation}`,
  pollLocaleConflict: (conversation: string, recorded: string, asked: string) =>
    `a conversa ${conversation} foi registrada em ${recorded}; um poll continua a conversa no idioma em que ela começou, e --locale ${asked} a mudaria no meio`,
  pollNoBundle: (runIds: string) => `nenhum bundle encontrado para ${runIds}: a conversa não pode ser retomada sem o registro dela`,
  pollBanner: (name: string, version: string, backend: string, conversation: string, openMinutes: number | undefined) =>
    `${name} ${version} — poll no canal whatsapp (${backend}) — conversa ${conversation} — janela de 24h ${openMinutes === undefined ? "FECHADA: só template aprovado" : `ABERTA (${openMinutes} min restantes): mensagem livre`}`,
  pollToldByText: "avisado por mensagem livre",
  pollToldByTemplate: (template: string, fallback: boolean) => `avisado por template ${template}${fallback ? " (reserva: o kit não tem cópia para este desfecho)" : ""}`,
  pollNotTold: (reason: string, detail: string | undefined) => `não avisado (${reason}${detail ? `: ${detail}` : ""})`,
  pollNoTemplateForOutcome: (outcome: string) => `a janela de 24h está fechada e o agente não declara template para ${outcome}, nem um template de reserva`,
  pollTemplateNotDeclared: (template: string) => `o kit pediu o template ${template}, que channels/whatsapp/templates.json não declara`,
  pollProviderRefused: "o provedor não aceitou a mensagem",

  // What a run did, counted from its executions: printed after the reply, whatever the reply says.
  runOutcome: (settled: number, failed: number, declined: number, alreadyPaid: number, open: number) =>
    settled + failed + declined + alreadyPaid + open === 0
      ? "resultado deste run: nenhuma execução; nada foi pago"
      : `resultado deste run: ${settled} liquidada(s), ${failed} com falha ou recusada(s), ${declined} negada(s) ou expirada(s), ${alreadyPaid} pulada(s) por já paga(s), ${open} em aberto`,
};

export type CoreStrings = typeof pt;

const en: CoreStrings = {
  execution: "execution",
  totalByCore: "total (computed by the core)",
  escalatedBy: "escalated by",
  blocked: (reasons, notAuthorized) => `blocked: ${reasons} — ${notAuthorized}; there is nothing to approve`,
  replayedSettlement: "already paid: the API answered with an earlier payment of this same attempt; this execution moved no money",

  onlyDeny: "  (the only possible outcome is to deny; press Enter)",
  leftAwaiting: "  left in awaiting_approval (run again with --approve or --deny)",
  afterLooks: (rounds, seconds, timedOut) => ` after ${rounds} look(s), ${seconds}s${timedOut ? " (timed out; `npm run poll` picks up where this stopped)" : ""}`,
  banner: (name, version, mode, rail, mandateWord, mandateId) => `${name} ${version} — approval: ${mode} — rail: ${rail} — ${mandateWord} ${mandateId}`,
  bundleAt: (runId, dir) => `run ${runId} — bundle in ${dir}`,

  batchHeader: (ref, label, count, total, hash) => `  batch ${ref} — ${label}: ${count} line(s), total ${total}, batch_hash ${hash}…`,
  batchAlreadySettled: " (already paid; does not run again)",
  batchInProgress: " (in progress; does not run again)",
  batchAttemptConflict: " (attempt bound to another payment; does not run again)",
  batchQuestion: "  Approve the list? [all / all except 3,7 / none] ",
  batchUnreadable: (count) => `  I did not understand; answer all, all except <numbers from 1 to ${count}> or none`,
  batchApprovedAll: "  -> list approved in full",
  batchDeniedAll: "  -> list denied in full",
  batchApprovedExcept: (positions) => `  -> list approved except ${positions}`,

  instalmentOf: (instalment, count) => `Instalment ${instalment}/${count}: `,
  dueOn: (date) => `, due ${date}`,
  chargeRef: (chargeId) => ` — charge ${chargeId}`,
  pixCopyPaste: "Pix copy and paste:",
  boletoLine: "Or pay the boleto with this line:",

  outsideCollectionHours: (window, timezone, clock) => `outside collection hours (${window} ${timezone}); it is ${clock} now`,

  scenarioReply: (text) => `agent: ${text}`,
  scenarioOk: (cycleSeconds, dir) => `== ok — ${cycleSeconds === undefined ? "" : cycleSeconds === null ? "no cycle measured — " : `${cycleSeconds}s — `}bundle in ${dir}`,

  waBanner: (name, version, backend, mode, rail, mandateWord, mandateId) => `${name} ${version} — channel: whatsapp (${backend}) — approval: ${mode} — rail: ${rail} — ${mandateWord} ${mandateId}`,
  waTapIgnored: (rule, detail) => `  [whatsapp] tap ignored (${rule}): ${detail}`,
  waRefused: (rule, detail) => `  [whatsapp] refused (${rule}): ${detail}`,
  waRefusedByBackend: (rule, detail) => `  [whatsapp] refused by the backend (${rule}): ${detail}`,
  waDeliveryFailed: (messageId, codes, told) => `  [operator] DELIVERY FAILED for message ${messageId} (${codes})${told ? ` — it told ${told}: the person was NOT told` : ""}`,
  waShop: "shop:",
  waTap: (title) => `[tap: ${title}]`,
  waTapIgnoredMark: (rule) => ` (ignored: ${rule})`,
  waNotSent: (rule) => `(not sent: ${rule})`,
  waCopyPaste: "[copy and paste]",
  waQrImage: "[image: Pix QR]",
  waYou: "  │ you> ",
  waEmulatorOpen: "  ┌─ WhatsApp (dyvit-wa-sim, a local Cloud API emulator — no external network, no Meta account)",
  waEmulatorClosed: "  └─ end of conversation",
  waConversationSummary: (log, received, sent, refused) => `conversation in ${log} — ${received === undefined ? "" : `${received} received, `}${sent} sent${refused ? `, ${refused} refused` : ""}`,
  waSimulatedCost: (total, currency) => `simulated cost of this conversation under Meta's rules: ${total} ${currency} (the emulator's figure, not ours)`,

  pollNoSubject: (conversation) =>
    `conversation ${conversation} declares no subject: there is no telling which executions are its own, and sending somebody else's outcome into this conversation is exactly what the secrecy rule forbids`,
  pollNothingWaiting: (conversation) => `nothing waiting for a payer in ${conversation}`,
  pollLocaleConflict: (conversation, recorded, asked) => `conversation ${conversation} was recorded in ${recorded}; a poll continues a conversation in the language it started in, and --locale ${asked} would switch it midway`,
  pollNoBundle: (runIds) => `no bundle found for ${runIds}: the conversation cannot be resumed without its record`,
  pollBanner: (name, version, backend, conversation, openMinutes) =>
    `${name} ${version} — poll on the whatsapp channel (${backend}) — conversation ${conversation} — 24h window ${openMinutes === undefined ? "SHUT: approved template only" : `OPEN (${openMinutes} min left): free-form message`}`,
  pollToldByText: "told by free-form message",
  pollToldByTemplate: (template, fallback) => `told by template ${template}${fallback ? " (fallback: the kit has no copy for this outcome)" : ""}`,
  pollNotTold: (reason, detail) => `not told (${reason}${detail ? `: ${detail}` : ""})`,
  pollNoTemplateForOutcome: (outcome) => `the 24h window is shut and the agent declares no template for ${outcome}, nor a fallback template`,
  pollTemplateNotDeclared: (template) => `the kit asked for template ${template}, which channels/whatsapp/templates.json does not declare`,
  pollProviderRefused: "the provider did not accept the message",

  runOutcome: (settled, failed, declined, alreadyPaid, open) =>
    settled + failed + declined + alreadyPaid + open === 0
      ? "result of this run: no execution; nothing was paid"
      : `result of this run: ${settled} settled, ${failed} failed or refused, ${declined} denied or expired, ${alreadyPaid} skipped as already paid, ${open} open`,
};

export const CORE_STRINGS: LocaleTable<CoreStrings> = { "pt-BR": pt, en };
