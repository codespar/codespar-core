/**
 * The WhatsApp channel: one adapter, two backends.
 *
 * Everything that decides what may be said lives HERE and not in a backend,
 * which is what makes "the rules are code" true rather than aspirational.
 * Picking the simulator or the official API changes who carries the bytes; it
 * does not change the hours, the bound contact, the secrecy of the debt, the
 * document rule or the session window. A test that tries to get around a rule
 * by choosing a backend is in `test/whatsapp-rules.test.ts` and fails.
 *
 * It also keeps the two audiences apart. `send` reaches the person who owes.
 * The operator's console and the approval question are wired to stderr by the
 * caller and have no path to this object at all — not a check, a shape: there
 * is no method here that an operator line could be handed to.
 */
import { declaredReplies, type ProofBundle, type QuickReply, type WhatsAppTemplate } from "@codespar/agent-core";
import { checkOutbound, type HoursRule, type RuleContext } from "../rules.js";
import type { Channel, ChannelBackend, ChannelLogLine, Conversation, DeliveryState, InboundMessage, OutboundBody, SentMessage, StatusUpdate } from "../types.js";
import { maskContact } from "../contact.js";
import { SessionWindow, type SessionState } from "./session.js";

export interface WhatsAppChannelOptions {
  backend: ChannelBackend;
  conversation: Conversation;
  now: () => Date;
  hours?: HoursRule | undefined;
  knownSubjects?: readonly string[] | undefined;
  /** The run's bundle, so the conversation is part of the proof. */
  bundle?: ProofBundle | undefined;
  /** Templates the agent declares it uses, from `channels/whatsapp/templates.json`. Meta's approval of them is not knowable from here. */
  templates?: readonly WhatsAppTemplate[] | undefined;
  /**
   * Where the window stood when an earlier run left this conversation. A run
   * that JOINS a conversation — a poll looking at a charge agreed yesterday —
   * has no inbound message of its own to open it from, and without this it
   * would read every conversation as shut.
   */
  session?: SessionState | undefined;
  /** The operator's console. Refusals are reported here, never to the conversation. */
  say?: ((line: string) => void) | undefined;
  /**
   * Draws the conversation for whoever is watching the run. It is a VIEW of
   * what went over the channel, written after the fact, and never a way to put
   * something in front of the person — that is `send`, and it is the only one.
   */
  render?: ((line: string) => void) | undefined;
  /**
   * The provider reported that a message the agent sent was NOT delivered.
   * Called with the status line, which names the outcome the message told
   * when it told one — that outcome was not told, whatever the send answered.
   */
  onDeliveryFailed?: ((line: ChannelLogLine) => void) | undefined;
  /** Lines an earlier run wrote for this conversation, so a status about a message it sent can be tied back to what that message was. */
  priorLines?: ReadonlyArray<ChannelLogLine> | undefined;
}

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  readonly conversation: Conversation;
  private readonly session: SessionWindow;
  private readonly lines: ChannelLogLine[] = [];
  private lastInbound: InboundMessage | undefined;
  private readonly replies: Map<string, QuickReply>;
  /** The latest state the provider reported per message id, this process. */
  private readonly delivery = new Map<string, DeliveryState>();
  /**
   * Failures reported for a message not yet in the log. A provider can post
   * the status before the send that minted the id has answered (the emulator
   * does, synchronously); the failure is acted on once the message is logged
   * and it is known what the message was.
   */
  private readonly earlyFailures = new Map<string, ChannelLogLine>();

  constructor(private readonly options: WhatsAppChannelOptions) {
    this.conversation = options.conversation;
    this.session = new SessionWindow(options.templates ?? [], options.session);
    this.replies = declaredReplies(options.templates ?? []);
  }

  get backend(): string {
    return this.options.backend.name;
  }

  /** Whether the backend talks to a real provider. What the consent-evidence seam turns on. */
  get live(): boolean {
    return this.options.backend.live;
  }

  /** The message the person last sent, for the caller that needs to attest to an act. */
  get lastInboundMessage(): InboundMessage | undefined {
    return this.lastInbound;
  }

  /**
   * Whether a free-form message may go out right now. A caller that has one
   * thing to say and two ways to say it asks HERE which one the provider
   * would carry — the alternative is composing a message, watching the
   * channel refuse it, and calling that a decision.
   */
  get sessionOpen(): boolean {
    return this.session.open(this.options.now());
  }

  /** Seconds of free-form left, for the console line that explains the choice. */
  get sessionRemainingSeconds(): number {
    return this.session.remainingSeconds(this.options.now());
  }

  /** The registry's fallback template, the one sent for an outcome the kit has no copy for. */
  fallbackTemplate(): string | undefined {
    return (this.options.templates ?? []).find((t) => t.fallback)?.name;
  }

  /** What the agent declared about a template it is about to send. The language is the registry's, never the sender's guess. */
  declaredTemplate(name: string): WhatsAppTemplate | undefined {
    return this.session.declared(name);
  }

  async open(): Promise<void> {
    this.options.backend.onStatus?.((status) => this.observeStatus(status));
    await this.options.backend.open();
  }

  /**
   * The person's next turn. A typed message is the turn. A TAPPED quick reply
   * is a turn only when its id is one a declared template offers, and then the
   * turn is that reply's declared intent, never the button's title and never
   * anything the model makes of it. A tap on an id nobody declared — or on a
   * message this conversation did not send, when the provider names the
   * message — is recorded, reported to the operator and skipped: a button the
   * agent never offered has no meaning to hand on.
   */
  async next(): Promise<InboundMessage | undefined> {
    for (;;) {
      const message = await this.options.backend.next();
      if (!message) return undefined;
      // Any inbound, tap or text, reopens the 24-hour window: the person wrote.
      this.lastInbound = message;
      this.session.observeInbound(message.timestamp);
      const base = {
        at: this.options.now().toISOString(),
        direction: "in" as const,
        contact: maskContact(message.from),
        message_id: message.id,
        state: "delivered" as const,
        // The provider's clock, which is the only one the 24-hour window is
        // counted on. A later run reads the window back from here.
        provider_timestamp: message.timestamp,
      };
      if (!message.reply) {
        this.record({ ...base, kind: "text", text: message.text });
        return message;
      }
      const tapped = { type: message.reply.type, id: message.reply.id, title: message.reply.title };
      const declared = this.replies.get(message.reply.id);
      const refusal = !declared
        ? { rule: "reply_not_offered", detail: `the person tapped ${message.reply.id}, which no template this agent declares offers; it is not a turn` }
        : message.reply.context_id && !this.offeredOn(message.reply.context_id, message.reply.id)
          ? { rule: "reply_not_offered", detail: `the tap names message ${message.reply.context_id}, which this conversation did not send with ${message.reply.id}` }
          : undefined;
      if (refusal) {
        this.record({ ...base, kind: "reply", reply: tapped, refused: refusal });
        this.options.say?.(`  [whatsapp] toque ignorado (${refusal.rule}): ${refusal.detail}`);
        continue;
      }
      this.record({ ...base, kind: "reply", reply: tapped, text: declared!.intent });
      return { ...message, text: declared!.intent };
    }
  }

  /** Whether the message the provider named is one this conversation sent carrying that reply. */
  private offeredOn(messageId: string, replyId: string): boolean {
    return [...(this.options.priorLines ?? []), ...this.lines].some((l) => l.direction === "out" && l.message_id === messageId && (l.offered ?? []).includes(replyId));
  }

  /**
   * A status webhook. Recorded in the conversation; a `failed` is also the
   * operator's business and, when the message told an outcome, the outcome's:
   * the provider just said the person never got it. A `read` is recorded and
   * nothing more — it says a device displayed the message, which is not
   * consent, not acknowledgement of a debt or an order, and not a reply.
   */
  private observeStatus(status: StatusUpdate): void {
    const sent = [...(this.options.priorLines ?? []), ...this.lines].find((l) => l.direction === "out" && l.message_id === status.message_id);
    this.delivery.set(status.message_id, status.status);
    const line: ChannelLogLine = {
      at: this.options.now().toISOString(),
      direction: "status",
      contact: maskContact(this.conversation.contact),
      kind: "status",
      message_id: status.message_id,
      state: status.status,
      provider_timestamp: status.timestamp,
      ...(sent?.about ? { about: sent.about } : {}),
      ...(status.errors.length ? { errors: status.errors } : {}),
    };
    this.record(line);
    if (status.status !== "failed") return;
    if (!sent) {
      this.earlyFailures.set(status.message_id, line);
      return;
    }
    this.reportFailure(line);
  }

  private reportFailure(line: ChannelLogLine): void {
    const status = { message_id: line.message_id, errors: line.errors ?? [] };
    const codes = status.errors.map((e) => `${e.code ?? "?"}${e.details ? ` ${e.details}` : ""}`).join("; ") || "no error given";
    this.options.say?.(
      `  [operador] ENTREGA FALHOU da mensagem ${status.message_id} (${codes})${line.about ? ` — era o aviso de ${line.about.execution_id} (${line.about.state}): a pessoa NAO foi avisada` : ""}`,
    );
    this.options.onDeliveryFailed?.(line);
  }

  /** The latest status the provider reported for a message this process saw a status for. */
  deliveryOf(messageId: string): DeliveryState | undefined {
    return this.delivery.get(messageId);
  }

  /**
   * Waits for status webhooks that may still be in flight. A provider reports
   * a failure after the send answered, and a process that exits first never
   * hears it; this is the short, bounded wait a caller that has just told an
   * outcome gives the provider before it reports the outcome as told.
   */
  async settle(ms: number): Promise<void> {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async send(body: OutboundBody): Promise<SentMessage> {
    const to = this.conversation.contact;
    const ctx: RuleContext = {
      conversation: this.conversation,
      hours: this.options.hours,
      now: this.options.now,
      knownSubjects: this.options.knownSubjects,
    };

    // The house rules first: a message the law refuses is not a message the provider should ever see.
    const refusal = checkOutbound(to, body, ctx) ?? this.providerRefusal(body);
    if (refusal) {
      const sent: SentMessage = { id: "", state: "failed", refused: refusal };
      this.logOutbound(body, sent);
      this.options.say?.(`  [whatsapp] recusado (${refusal.rule}): ${refusal.detail}`);
      return sent;
    }

    // A template carries the quick replies its declaration offers, and only those.
    const buttons = body.kind === "template" ? this.session.declared(body.template)?.buttons : undefined;
    const outgoing: OutboundBody = body.kind === "template" && buttons?.length ? { ...body, buttons: buttons.map((b) => ({ id: b.id, title: b.title })) } : body;
    const sent = await this.options.backend.deliver(to, outgoing);
    if (sent.refused) this.options.say?.(`  [whatsapp] recusado pelo backend (${sent.refused.rule}): ${sent.refused.detail}`);
    if (sent.refused?.rule === "session_window_closed") this.session.observeProviderShut();
    this.logOutbound(outgoing, sent);
    return sent;
  }

  say(text: string): Promise<SentMessage> {
    return this.send({ kind: "text", text });
  }

  async close(): Promise<void> {
    await this.options.backend.close();
  }

  /** Every message of this conversation, in order. */
  log(): ReadonlyArray<ChannelLogLine> {
    return this.lines;
  }

  private logOutbound(body: OutboundBody, sent: SentMessage): void {
    const early = sent.id ? this.earlyFailures.get(sent.id) : undefined;
    if (early) {
      this.earlyFailures.delete(sent.id);
      const about = (body.kind === "text" || body.kind === "template") && body.about ? body.about : undefined;
      queueMicrotask(() => this.reportFailure({ ...early, ...(about ? { about } : {}) }));
    }
    this.record({
      at: this.options.now().toISOString(),
      direction: "out",
      contact: maskContact(this.conversation.contact),
      kind: body.kind,
      message_id: sent.id,
      state: sent.state,
      ...(textOf(body) !== undefined ? { text: textOf(body)! } : {}),
      ...(sent.refused ? { refused: sent.refused } : {}),
      ...((body.kind === "text" || body.kind === "template") && body.about ? { about: body.about } : {}),
      ...(body.kind === "template" && body.buttons?.length ? { offered: body.buttons.map((b) => b.id) } : {}),
    });
  }

  /**
   * WhatsApp's own rule, enforced on both backends: outside the 24 hours
   * after the person's last message only an approved template may go out.
   * The simulator obeys it because a rule that only bites in production is a
   * rule you meet in production.
   */
  private providerRefusal(body: OutboundBody): { rule: string; detail: string } | undefined {
    const open = this.session.open(this.options.now());
    if (body.kind === "template") return this.session.refuse(body);
    if (!open) {
      return {
        rule: "session_window_closed",
        detail: "more than 24h since the person's last message: WhatsApp only carries an approved template now, not a free-form message",
      };
    }
    return undefined;
  }

  private record(line: ChannelLogLine): void {
    this.lines.push(line);
    this.options.bundle?.channel({ ...line, channel: "whatsapp", backend: this.backend });
    this.options.render?.(`  │ ${draw(line)}`);
  }
}

/** One console line for one message. The refusals are visible: a message nobody got is part of the conversation's story. */
function draw(line: ChannelLogLine): string {
  if (line.direction === "status") return `(status ${line.message_id}: ${line.state}${line.errors?.length ? ` ${line.errors.map((e) => e.code).join(",")}` : ""})`;
  if (line.kind === "reply") return `${line.contact}: [toque: ${line.reply?.title ?? "?"}]${line.refused ? ` (ignorado: ${line.refused.rule})` : ` -> ${line.text ?? ""}`}`;
  const who = line.direction === "in" ? `${line.contact}:` : "loja:";
  const what =
    line.kind === "instrument"
      ? `[copia e cola] ${line.text ?? ""}`
      : line.kind === "media"
        ? "[imagem: QR Pix]"
        : line.kind === "template"
          ? line.text ?? "[template]"
          : line.text ?? "";
  return line.refused ? `${who} (nao enviada: ${line.refused.rule}) ${what}` : `${who} ${what}`;
}

function textOf(body: OutboundBody): string | undefined {
  switch (body.kind) {
    case "text":
      return body.text;
    case "instrument":
      return body.value;
    case "media":
      return body.caption;
    case "template":
      return `[template ${body.template}] ${body.variables.join(" | ")}${body.buttons?.length ? ` [${body.buttons.map((b) => b.title).join("] [")}]` : ""}`;
  }
}

export * from "../contact.js";
export * from "./cloud-api.js";
export * from "./emulator.js";
export * from "./evidence.js";
export * from "./session.js";
