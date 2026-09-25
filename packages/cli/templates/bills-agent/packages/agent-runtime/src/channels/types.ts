/**
 * One interface, several backends. What a channel is, from the runner's side:
 * a place a person writes from, a place the agent writes to, and a record of
 * what happened to each message.
 *
 * The shape is deliberately the shape of a MESSAGING channel and not of a
 * terminal, because the two are not the same thing and pretending they are is
 * how an approval question ends up in a debtor's chat. A terminal has one
 * stream and one reader; a channel has a counterparty on one side and an
 * operator somewhere else entirely, and the runner keeps them apart by
 * construction: `send` reaches the counterparty, and the operator's console
 * and questions never touch it.
 *
 * Every backend answers the same five questions, and the ADAPTER above them
 * (`whatsapp/index.ts`) is where the rules live, so a rule cannot be skipped
 * by choosing a different backend.
 */
import type { ChannelName } from "@codespar/agent-core";

/**
 * What a provider tells us about a message after it left. `queued` is ours
 * (accepted, not yet handed over); the rest are the provider's own, and a
 * backend that cannot observe one never invents it.
 */
export type DeliveryState = "queued" | "sent" | "delivered" | "read" | "failed";

export interface InboundMessage {
  /** The PROVIDER's message id (`wamid....` on WhatsApp). Never ours. */
  id: string;
  /** Who wrote it, E.164 on WhatsApp. */
  from: string;
  text: string;
  /** Unix seconds on the PROVIDER's clock, which is not this process's clock. */
  timestamp: number;
}

/**
 * What the agent can put on a channel.
 *
 * `text` is the ordinary message. `media` is a QR, which on WhatsApp is an
 * image and never ASCII art. `template` is the only thing a provider accepts
 * outside the 24-hour session window, which is why it is a separate kind
 * rather than a flag.
 *
 * `instrument` is the Pix copy-and-paste or the boleto line, and it is its own
 * kind for a reason that is not cosmetic: those strings are minted by the rail
 * and are long runs of digits, and the rule that keeps a CPF out of a message
 * would refuse a boleto line (whose last field is fourteen digits) if it read
 * one as prose. Separating them says which strings the conversation composed
 * and which the rail did, and only the first are checked for a document.
 */
export type OutboundBody =
  | { kind: "text"; text: string }
  | { kind: "media"; media: "qr"; data: string; caption?: string }
  | { kind: "instrument"; instrument: "pix_copy_paste" | "boleto_bank_line"; value: string }
  | { kind: "template"; template: string; language: string; variables: string[] };

export interface SentMessage {
  /** The provider's id when it accepted one, else the id the backend minted. */
  id: string;
  state: DeliveryState;
  /**
   * Set when something REFUSED the message. Nothing left the process: a
   * refusal here is not a delivery failure, it is the message never having
   * been sent. `rule` is the stable name a test and a log both key on.
   */
  refused?: { rule: string; detail: string };
}

/** What the person on the other side is called, and what the conversation may be about. */
export interface Conversation {
  /** The contact the conversation is bound to. Every outbound goes here and nowhere else. */
  contact: string;
  /** What the conversation may name — an agreement alias. Absent means the channel enforces no subject rule. */
  subject?: string | undefined;
}

export interface ChannelBackend {
  /** `simulator`, `cloud-api`. Named in the console, in the bundle and in the gate's output. */
  readonly name: string;
  /** Whether this backend talks to a real provider. The gate and the tests refuse to run a live one. */
  readonly live: boolean;
  open(): Promise<void>;
  /** The next inbound message, or `undefined` when the conversation is over. */
  next(): Promise<InboundMessage | undefined>;
  /** Hands the message to the provider. Rules have already run: a backend never re-decides policy. */
  deliver(to: string, body: OutboundBody): Promise<SentMessage>;
  close(): Promise<void>;
}

export interface Channel {
  readonly name: ChannelName;
  readonly backend: string;
  readonly conversation: Conversation;
  open(): Promise<void>;
  next(): Promise<InboundMessage | undefined>;
  /** Applies the channel's rules, then delivers. A refused message is recorded and never sent. */
  send(body: OutboundBody): Promise<SentMessage>;
  /** Convenience for the common case. */
  say(text: string): Promise<SentMessage>;
  close(): Promise<void>;
  /** Every message of this conversation, in order, as the bundle records it. */
  log(): ReadonlyArray<ChannelLogLine>;
}

export interface ChannelLogLine {
  at: string;
  direction: "in" | "out";
  /** The contact, MASKED. The raw value never reaches a file. */
  contact: string;
  kind: OutboundBody["kind"];
  /** The provider's id, or ours when nothing was sent. */
  message_id: string;
  state: DeliveryState;
  text?: string;
  /**
   * Inbound only: the PROVIDER's own timestamp, unix seconds. Recorded
   * because the 24-hour session window is counted on WhatsApp's clock and
   * `at` is this process's, and a later run has to read the window back from
   * this log rather than from a clock it does not share.
   */
  provider_timestamp?: number;
  refused?: { rule: string; detail: string };
}
