/**
 * The terminal channel: what `npm start` opens. No account, no server. The
 * person typing is the PAYER (in production, over WhatsApp); the operator's
 * approval in `human` mode is asked on the same keyboard, labelled as such.
 * It shows what the core decided, presents the QR and the copy-and-paste
 * when the receivable is payable, and tells the payer the outcome once.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout } from "node:process";
import { relative } from "node:path";
import qrcode from "qrcode-terminal";
import type { ChargeInstrument, Execution } from "@codespar/agent-core";
import { formatBRL, formatDate } from "../../src/agreements.js";
import { pollUntilClosed, type PollResult } from "../../src/poll.js";
import type { Setup } from "../../src/setup.js";

export interface TerminalOptions {
  setup: Setup;
  approver: { id: string; channel: string };
  /** Non-interactive decision for `--input`: approve, deny, or leave it awaiting. */
  decision?: "approve" | "deny" | "none";
  /** Seconds to wait for the payer after issuing. */
  waitSeconds?: number | undefined;
  /** Let the sandbox payer (the fixture, or the API's test route) pay once the receivable is payable. */
  simulatePayer?: boolean | undefined;
  say?: ((line: string) => void) | undefined;
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Where the lines for the PAYER go (the conversation); `say` is the operator's console. */
  tell?: ((line: string) => void) | undefined;
}

export function describeExecution(execution: Execution, setup: Setup): string[] {
  const lines: string[] = [];
  const debtor = execution.items[0]?.beneficiary ?? "?";
  lines.push(`  execucao ${execution.id}: ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`);
  lines.push(`    acordo de ${debtor} (${execution.items[0]?.alias ?? "?"})`);
  for (const [i, item] of execution.items.entries()) lines.push(`    - parcela ${i + 1}/${execution.items.length}: ${formatBRL(item.amount)}, vence ${item.due_date ? formatDate(item.due_date) : "?"}`);
  lines.push(`    total (calculado pelo core): ${formatBRL(execution.total)}`);
  if (execution.escalation) lines.push(`    escalado por: ${execution.escalation.trigger} — ${execution.escalation.detail}`);
  if (execution.blocking_reasons.length) lines.push(`    bloqueado: ${execution.blocking_reasons.join(", ")} — a politica nao autoriza; nao ha o que aprovar`);
  if (execution.detail && execution.state !== "awaiting_approval") lines.push(`    ${execution.detail}`);
  for (const outcome of execution.outcomes) {
    if (outcome.transaction_id) lines.push(`    cobranca ${outcome.index + 1}: ${outcome.transaction_id} — ${outcome.status}${outcome.code ? ` (${outcome.code})` : ""}`);
    if (outcome.receipt_id) lines.push(`    registro: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
  }
  return lines;
}

/** What the payer reads when a receivable is payable: the QR as an image, the copy-and-paste under it, the bank line if any. */
export function presentInstrument(execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, tell: (line: string) => void): void {
  const item = execution.items[instalment - 1];
  const count = execution.items.length;
  tell("");
  tell(`${count > 1 ? `Parcela ${instalment}/${count}: ` : ""}${item ? formatBRL(item.amount) : ""}${instrument.due_date ? `, vence ${formatDate(instrument.due_date)}` : ""} — cobranca ${chargeId}`);
  if (instrument.pix_copy_paste) {
    qrcode.generate(instrument.pix_copy_paste, { small: true }, (qr: string) => {
      for (const line of qr.split("\n")) tell(line);
    });
    tell("Pix copia e cola:");
    tell(instrument.pix_copy_paste);
  }
  if (instrument.boleto_bank_line) {
    tell("Ou pelo boleto, linha digitavel:");
    tell(instrument.boleto_bank_line);
  }
  tell("");
}

/** The one message per outcome, recorded so a duplicate event never sends it twice. */
export function announceOutcome(execution: Execution, setup: Setup, tell: (line: string) => void): boolean {
  if (execution.state === "executing") return false;
  if (!setup.engine.markTold(execution.id, execution.state)) return false;
  let text: string;
  if (execution.state === "settled") text = `Recebemos, acordo quitado. Obrigado! (${execution.outcomes.map((o) => o.transaction_id).filter(Boolean).join(", ")})`;
  else if (execution.reason === "charge_expired") text = "A cobranca venceu sem pagamento. Se quiser, emito uma nova dentro das mesmas condicoes.";
  else if (execution.reason === "charge_cancelled") text = "A cobranca foi cancelada. Nada foi pago.";
  else if (execution.state === "failed") text = `Nao consegui emitir a cobranca (${execution.reason ?? "falha no trilho"}). Nada foi cobrado.`;
  else if (execution.state === "denied") text = `Nao posso emitir nesses termos (${execution.reason ?? "recusado"}).`;
  else text = `A proposta expirou sem decisao (${execution.state}).`;
  tell(text);
  setup.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, text });
  return true;
}

/** Decides an `awaiting_approval` execution, runs an `approved` one, and waits for the payer. Returns the final execution of this pass. */
export async function handleExecution(execution: Execution, options: TerminalOptions): Promise<Execution> {
  const { setup, approver } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const tell = options.tell ?? ((l: string) => stdout.write(l + "\n"));
  const engine = setup.engine;

  for (const line of describeExecution(execution, setup)) say(line);

  let current = execution;
  if (current.state === "awaiting_approval") {
    let decision = options.decision;
    if (!decision) {
      if (current.blocking_reasons.length > 0) say("  (o unico desfecho possivel e negar; aperte Enter)");
      const ask = options.ask ?? defaultAsk;
      const answer = (await ask("  [operador] Aprovar a emissao desta cobranca? [s/N] ")).trim().toLowerCase();
      decision = answer === "s" || answer === "sim" || answer === "y" || answer === "yes" ? "approve" : "deny";
    }
    if (decision === "approve") current = engine.approve(current.id, approver);
    else if (decision === "deny") current = engine.deny(current.id, approver);
    else {
      say("  deixado em awaiting_approval (rode de novo com --approve ou --deny)");
      return current;
    }
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
  }

  if (current.state === "approved") {
    current = await engine.execute(current.id);
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""}`);
  }

  if (current.state === "executing" && current.reason === "awaiting_settlement") {
    const result = await waitForPayer(current.id, options);
    current = result.execution;
    say(`  -> ${current.state}${current.reason ? ` (${current.reason})` : ""} apos ${result.rounds} consulta(s), ${result.seconds}s${result.timed_out ? " (tempo esgotado; `npm run poll` continua de onde parou)" : ""}`);
    for (const outcome of current.outcomes) if (outcome.receipt_id) say(`  registro: ${relative(process.cwd(), `${setup.bundle.dir}/receipts/${outcome.receipt_id}.json`)}`);
  } else if (current.state === "executing") {
    say("  desfecho desconhecido no trilho; rode `npm run resume` para reconciliar (nunca repita a emissao)");
  }
  announceOutcome(current, setup, tell);
  return current;
}

export async function waitForPayer(executionId: string, options: TerminalOptions): Promise<PollResult> {
  const { setup } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const tell = options.tell ?? ((l: string) => stdout.write(l + "\n"));
  const waitSeconds = options.waitSeconds ?? (setup.railKind === "api" ? 60 : 0);
  return pollUntilClosed(setup.engine, executionId, {
    intervalMs: setup.pollIntervalMs,
    timeoutMs: waitSeconds * 1000,
    payer: options.simulatePayer ? setup.payer : undefined,
    onInstrument: (e, n, id, instrument) => presentInstrument(e, n, id, instrument, tell),
    onWait: (_e, round) => {
      if (setup.railKind === "api" && round % 5 === 0) say(`  aguardando o pagador... (${round} consultas)`);
    },
  });
}

let rl: ReturnType<typeof createInterface> | undefined;

export function defaultAsk(question: string): Promise<string> {
  rl ??= createInterface({ input: stdin, output: stderr });
  return rl.question(question);
}

export function closeTerminal(): void {
  rl?.close();
  rl = undefined;
}

export async function interactive(options: TerminalOptions & { runtime: import("@codespar/agent-core").AgentRuntime }): Promise<void> {
  const { setup } = options;
  const say = options.say ?? ((l: string) => stderr.write(l + "\n"));
  const loop = setup.makeLoop(options.runtime, (execution) => handleExecution(execution, options));
  say(`collections-agent ${setup.manifest.manifest.version} — approval: ${setup.mode} — trilho: ${setup.railKind} — politica ${setup.mandate.id}`);
  say(`run ${setup.runId} — bundle em ${relative(process.cwd(), setup.bundle.dir)}`);
  say('Voce e o pagador. Diga algo ("oi, recebi a mensagem sobre o acordo do pedido 1042"). Ctrl+D ou "sair" encerra.');
  for (;;) {
    let text: string;
    try {
      text = await defaultAsk("pagador> ");
    } catch {
      break;
    }
    const trimmed = text.trim();
    if (!trimmed) continue;
    if (["sair", "exit", "quit"].includes(trimmed.toLowerCase())) break;
    const result = await loop.turn(trimmed);
    stdout.write(result.reply + "\n");
  }
  closeTerminal();
}
