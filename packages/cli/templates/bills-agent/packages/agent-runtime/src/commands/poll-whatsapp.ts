/**
 * `codespar-agent poll --channel whatsapp`: the conversation's loop-closer.
 *
 * The terminal already had one, and the reason the channel needs its own is
 * the whole of issue #25. Over a terminal the operator and the counterparty
 * are the same pair of eyes and the run never really ends. Over WhatsApp the
 * debtor agrees on Tuesday and pays on Friday: the run that issued the charge
 * exited days ago, and by the time the money lands the 24-hour customer
 * service window has shut, so "recebemos, acordo quitado" can only go out as
 * a template Meta approved in advance. Without this command that case cannot
 * be run at all, which is why the confirmation in every recorded run so far
 * happened inside the turn that issued the charge.
 *
 * What it does: reopens a conversation from the RECORD — the bundle of the
 * run that held it, plus `state.db` — looks at the receivable the way the
 * terminal poll does, and puts the outcome back into that same conversation.
 * Nothing about which message may be sent is decided here: the channel's
 * rules and the session window decide, and this only ASKS the window which of
 * the two carriers it may use, because composing a message in order to watch
 * it be refused is not a decision.
 *
 * Three things it deliberately does not do. It does not invent a conversation
 * when there is nothing waiting for a payer — that is a no-op and exits 0,
 * because a cron that fails when there is no work is a cron somebody turns
 * off. It does not send a second confirmation when it runs twice, because the
 * once-only cursor is in `state.db` and outlives the process. And it does not
 * pin the emulator's clock, unlike the run that started the conversation:
 * rewinding the provider's clock would reopen a window that really is shut.
 */
import { stdout } from "node:process";
import { relative } from "node:path";
import { ProofBundle, type ChargeInstrument, type Execution } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import { runsDir, type Setup } from "../setup.js";
import { waitForPayer } from "../terminal.js";
import { resolveConversation } from "../channels/index.js";
import { buildWhatsApp, simulatedCost, type WhatsAppBackendName } from "../channels/whatsapp/open.js";
import { EmulatorUnreachableError } from "../channels/whatsapp/emulator.js";
import { sessionStateFromChannelLog, type SessionState } from "../channels/whatsapp/session.js";
import { instrumentBodies } from "../channels/whatsapp/present.js";
import type { WhatsAppChannel } from "../channels/whatsapp/index.js";
import type { SentMessage } from "../channels/types.js";

export interface PollWhatsAppOptions {
  agent: Agent;
  setup: Setup;
  conversation: string | undefined;
  backend: WhatsAppBackendName;
  json: boolean;
  waitSeconds?: number | undefined;
  simulatePayer?: boolean | undefined;
  /** Stub only: what the fixture payer does with the receivables THIS conversation is waiting on. */
  payer?: "pays" | "expires" | "never" | undefined;
  now: () => Date;
  say: (line: string) => void;
}

/** How the outcome reached the person, or why it did not. */
type Delivery =
  | { told: true; carrier: "text" | "template"; template?: string }
  | { told: false; reason: "already_told" | "still_open" | "no_template_for_outcome" | "refused"; detail?: string };

interface Polled {
  id: string;
  state: string;
  reason: string | null;
  rounds: number;
  seconds: number;
  timed_out: boolean;
  session_open: boolean;
  delivery: Delivery;
}

export async function pollWhatsApp(options: PollWhatsAppOptions): Promise<number> {
  const { agent, setup: s, say, now } = options;

  let script;
  try {
    script = resolveConversation(agent, options.conversation);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 2;
  }

  // Which open executions belong to THIS conversation. The binding is the
  // conversation's subject — the agreement alias it is allowed to name — and
  // that is not a convenience: sending one debtor's outcome into another
  // debtor's chat is the secrecy rule broken, and the same `subject` is what
  // the channel already refuses other agreements by. A conversation that
  // declares no subject binds to nothing and says so, rather than taking
  // every open execution and hoping.
  const open = s.engine.list({ state: "executing" }).filter((e) => e.reason === "awaiting_settlement");
  const subject = script.subject;
  // EVERY item, not some: an execution that mixes this conversation's
  // agreement with another's belongs to neither, and confirming it here would
  // put somebody else's debt in front of this person.
  const mine = subject ? open.filter((e) => e.items.length > 0 && e.items.every((i) => i.alias === subject || i.payee === subject)) : [];

  if (!subject && open.length) {
    say(`a conversa ${script.name} nao declara subject: nao da para dizer quais execucoes sao dela, e mandar o desfecho de outra pessoa nesta conversa e exatamente o que a regra de sigilo proibe`);
    return 2;
  }
  if (!mine.length) {
    // A clean no-op: nothing is waiting, so nothing is opened. The emulator is
    // not even contacted, which is the point — a poll with no work does no work.
    if (options.json) stdout.write(JSON.stringify({ polled: [], conversation: script.name, channel: null }) + "\n");
    else say(`nada aguardando pagador em ${script.name}`);
    return 0;
  }

  // The conversation as it was left: the bundle of the run that held it. The
  // window is counted from the person's last message on the PROVIDER's clock,
  // which only that record holds, and the confirmation is appended THERE, so
  // one conversation stays one record instead of ending in a second folder.
  const { bundle, session } = conversationRecord(agent, mine);
  if (!bundle) {
    say(`nenhum bundle encontrado para ${mine.map((e) => e.run_id).join(", ")}: a conversa nao pode ser retomada sem o registro dela`);
    return 1;
  }

  const built = buildWhatsApp({
    agent,
    setup: s,
    conversation: { contact: script.contact, subject: script.subject },
    backend: options.backend,
    now,
    say,
    bundle,
    // Nobody writes in a poll: the person already said what they had to say,
    // and this run is here because the PAYER acted, not because the person did.
    session,
  });
  if ("refusal" in built) {
    for (const line of built.refusal) say(line);
    return 1;
  }
  const { channel, driver, sessionKey } = built;

  // Scoped to the receivables of THIS conversation: `behave` set the default
  // for new ones, and this rewrites the fate of the ones already issued —
  // another conversation's charge is none of this command's business.
  if (options.payer) {
    for (const execution of mine) {
      for (const outcome of execution.outcomes) if (outcome.status === "accepted") s.payer?.decideFor?.(outcome.attempt_id, options.payer);
    }
  }

  try {
    await channel.open();
  } catch (err) {
    if (err instanceof EmulatorUnreachableError) {
      say(err.message);
      return 1;
    }
    throw err;
  }

  const results: Polled[] = [];
  try {
    const remaining = channel.sessionRemainingSeconds;
    say(
      `${s.manifest.manifest.name} ${s.manifest.manifest.version} — poll no canal whatsapp (${channel.backend}) — conversa ${script.name} — janela de 24h ${
        channel.sessionOpen ? `ABERTA (${Math.round(remaining / 60)} min restantes): mensagem livre` : "FECHADA: so template aprovado"
      }`,
    );
    for (const execution of mine) {
      const sessionOpen = channel.sessionOpen;
      const result = await waitForPayer(execution.id, {
        setup: s,
        approver: { id: s.kit.labels.defaultUser, channel: "whatsapp" },
        say,
        waitSeconds: options.waitSeconds,
        simulatePayer: options.simulatePayer,
        presentInstrument: (e, n, id, instrument) => presentInstrument(channel, s, e, n, id, instrument),
      });
      const closed = result.execution;
      if (closed.state !== "executing") await s.engine.collectReceipts(closed.id);
      const delivery = await tellOutcome(channel, s, closed);
      results.push({
        id: closed.id,
        state: closed.state,
        reason: closed.reason ?? null,
        rounds: result.rounds,
        seconds: result.seconds,
        timed_out: result.timed_out,
        session_open: sessionOpen,
        delivery,
      });
      say(
        `${closed.id}: ${closed.state}${closed.reason ? ` (${closed.reason})` : ""} apos ${result.rounds} consulta(s), ${result.seconds}s — ${
          delivery.told ? `avisado por ${delivery.carrier === "template" ? `template ${delivery.template}` : "mensagem livre"}` : `nao avisado (${delivery.reason}${delivery.detail ? `: ${delivery.detail}` : ""})`
        }`,
      );
    }
  } finally {
    await channel.close();
  }

  const cost = await simulatedCost(driver, sessionKey);
  const log = channel.log();
  const refused = log.filter((l) => l.refused).map((l) => ({ rule: l.refused!.rule, detail: l.refused!.detail }));
  const channelSummary = {
    name: "whatsapp",
    backend: channel.backend,
    conversation: script.name,
    session_open: channel.sessionOpen,
    messages_out: log.filter((l) => l.direction === "out" && !l.refused).length,
    refused,
    log: relative(process.cwd(), `${bundle.dir}/channel.jsonl`),
    ...(cost ? { simulated_cost: cost } : {}),
  };

  if (options.json) stdout.write(JSON.stringify({ polled: results, conversation: script.name, channel: channelSummary }) + "\n");
  else say(`conversa em ${channelSummary.log} — ${channelSummary.messages_out} enviada(s)${refused.length ? `, ${refused.length} recusada(s)` : ""}`);

  if (results.some((r) => r.timed_out)) return 3;
  // A cycle that closed and a person who was not told is a failure worth an
  // exit code: the record says the agreement is settled and the debtor does
  // not know it. The other two are not failures — `already_told` is this
  // command running twice, which is the thing it is built to be safe under,
  // and `still_open` is a wait that ran out, which the 3 above already said.
  return results.some((r) => !r.delivery.told && r.delivery.reason !== "already_told" && r.delivery.reason !== "still_open") ? 1 : 0;
}

/**
 * The bundle the conversation lives in, and where its window stood. When
 * several runs touched the same conversation the LATEST one holds the last
 * inbound, so that is the record the confirmation is appended to; the window
 * itself is read across all of them, because the person's last message is the
 * person's last message whichever run recorded it.
 */
function conversationRecord(agent: Agent, executions: readonly Execution[]): { bundle: ProofBundle | undefined; session: SessionState } {
  const runs = runsDir(agent);
  const seen = new Set<string>();
  let bundle: ProofBundle | undefined;
  let lastInboundAt: number | undefined;
  // `list()` orders by creation, so the last execution that carries a log is the most recent record of the conversation.
  for (const execution of executions) {
    if (seen.has(execution.run_id)) continue;
    seen.add(execution.run_id);
    const opened = ProofBundle.open(runs, execution.run_id);
    if (!opened) continue;
    const lines = opened.readChannel();
    if (!lines.length) continue;
    bundle = opened;
    const state = sessionStateFromChannelLog(lines);
    if (state.lastInboundAt !== undefined && (lastInboundAt === undefined || state.lastInboundAt > lastInboundAt)) lastInboundAt = state.lastInboundAt;
  }
  return { bundle, session: { lastInboundAt } };
}

/**
 * The payable artifact, the way a person can use it: the QR as an image and
 * the copy-and-paste as its OWN message. The same shape `converse` sends,
 * because a payer told how to pay by a poll is told the same way a payer told
 * by a run is.
 *
 * It is only reached for an instrument nobody has shown yet — `markShown` is a
 * cursor in `state.db` — so in the ordinary resumed conversation nothing is
 * sent here at all. When it IS reached with the window shut the channel
 * refuses it, and that refusal is the record: WhatsApp would not have carried
 * it either.
 */
async function presentInstrument(channel: WhatsAppChannel, s: Setup, execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument): Promise<void> {
  for (const body of instrumentBodies(execution, instalment, chargeId, instrument, s.mandate.currency)) await channel.send(body);
}

/**
 * The one message per outcome, carried by whichever of the two the window
 * allows. Both halves share `markTold`, the cursor in `state.db`, so a second
 * poll sends nothing whichever carrier the first one used.
 *
 * The order matters and is deliberate: the cursor is taken BEFORE the send.
 * Taking it after would mean a process killed between the send and the write
 * tells the person twice, and on a channel that is a second "recebemos" for
 * one payment. A send that is then refused is reported instead, with the
 * rule, and it is the exit code of the command — the record says settled and
 * the debtor does not know.
 */
async function tellOutcome(channel: WhatsAppChannel, s: Setup, execution: Execution): Promise<Delivery> {
  // Nothing closed, so there is no outcome to carry. Not a failure and not a
  // silence to explain: the wait ran out and the receivable is still open.
  if (execution.state === "executing") return { told: false, reason: "still_open" };

  if (channel.sessionOpen) {
    // The kit writes lines, the channel sends messages. Joined rather than
    // last-one-wins, so a kit that says two sentences does not lose one.
    const lines: string[] = [];
    const told = s.kit.announceOutcome?.(execution, s, (line) => void lines.push(line)) ?? false;
    if (!told) return { told: false, reason: "already_told" };
    const sent = await channel.send({ kind: "text", text: lines.join("\n") });
    return deliveryOf(sent, "text");
  }

  const chosen = s.kit.outcomeTemplate?.(execution);
  if (!chosen) {
    return {
      told: false,
      reason: "no_template_for_outcome",
      detail: `a janela de 24h esta fechada e o agente nao declara template para ${execution.state}${execution.reason ? ` (${execution.reason})` : ""}`,
    };
  }
  const declared = channel.declaredTemplate(chosen.template);
  if (!declared) {
    return { told: false, reason: "no_template_for_outcome", detail: `o kit pediu o template ${chosen.template}, que channels/whatsapp/templates.json nao declara` };
  }
  if (!s.engine.markTold(execution.id, execution.state)) return { told: false, reason: "already_told" };
  const sent = await channel.send({ kind: "template", template: declared.name, language: declared.language, variables: chosen.variables });
  s.engine.note("message.debtor", execution.id, { state: execution.state, reason: execution.reason ?? null, template: declared.name, variables: chosen.variables });
  return deliveryOf(sent, "template", declared.name);
}

function deliveryOf(sent: SentMessage, carrier: "text" | "template", template?: string): Delivery {
  if (sent.refused) return { told: false, reason: "refused", detail: `${sent.refused.rule}: ${sent.refused.detail}` };
  if (sent.state === "failed") return { told: false, reason: "refused", detail: "o provedor nao aceitou a mensagem" };
  return { told: true, carrier, ...(template ? { template } : {}) };
}
