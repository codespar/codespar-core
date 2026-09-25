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
import type { ProofBundle, WhatsAppTemplate } from "@codespar/agent-core";
import { checkOutbound, type HoursRule, type RuleContext } from "../rules.js";
import type { Channel, ChannelBackend, ChannelLogLine, Conversation, InboundMessage, OutboundBody, SentMessage } from "../types.js";
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
}

export class WhatsAppChannel implements Channel {
  readonly name = "whatsapp" as const;
  readonly conversation: Conversation;
  private readonly session: SessionWindow;
  private readonly lines: ChannelLogLine[] = [];
  private lastInbound: InboundMessage | undefined;

  constructor(private readonly options: WhatsAppChannelOptions) {
    this.conversation = options.conversation;
    this.session = new SessionWindow(options.templates ?? [], options.session);
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

  /** What the agent declared about a template it is about to send. The language is the registry's, never the sender's guess. */
  declaredTemplate(name: string): WhatsAppTemplate | undefined {
    return this.session.declared(name);
  }

  async open(): Promise<void> {
    await this.options.backend.open();
  }

  async next(): Promise<InboundMessage | undefined> {
    const message = await this.options.backend.next();
    if (!message) return undefined;
    this.lastInbound = message;
    this.session.observeInbound(message.timestamp);
    this.record({
      at: this.options.now().toISOString(),
      direction: "in",
      contact: maskContact(message.from),
      kind: "text",
      message_id: message.id,
      state: "delivered",
      text: message.text,
      // The provider's clock, which is the only one the 24-hour window is
      // counted on. A later run reads the window back from here.
      provider_timestamp: message.timestamp,
    });
    return message;
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

    const sent = await this.options.backend.deliver(to, body);
    if (sent.refused) this.options.say?.(`  [whatsapp] recusado pelo backend (${sent.refused.rule}): ${sent.refused.detail}`);
    this.logOutbound(body, sent);
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
    this.record({
      at: this.options.now().toISOString(),
      direction: "out",
      contact: maskContact(this.conversation.contact),
      kind: body.kind,
      message_id: sent.id,
      state: sent.state,
      ...(textOf(body) !== undefined ? { text: textOf(body)! } : {}),
      ...(sent.refused ? { refused: sent.refused } : {}),
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
      return `[template ${body.template}] ${body.variables.join(" | ")}`;
  }
}

export * from "../contact.js";
export * from "./cloud-api.js";
export * from "./emulator.js";
export * from "./evidence.js";
export * from "./session.js";
