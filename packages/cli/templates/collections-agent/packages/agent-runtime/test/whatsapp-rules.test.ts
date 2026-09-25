/**
 * The rules of collecting over a conversation, tried and refused.
 *
 * Every case here is an ATTEMPT: the message is handed to the channel the way
 * the runner hands it one, and what is asserted is that nothing left the
 * process. The backend under the channel is a recorder, so "refused" is not a
 * claim about a return value — it is the recorder having seen nothing.
 *
 * The last case is the one that matters most: the same attempts through a
 * DIFFERENT backend. The rules live above the backend, so choosing one cannot
 * be a way around them.
 */
import { describe, expect, it } from "vitest";
import { WhatsAppChannel } from "../src/channels/whatsapp/index.js";
import { checkOutbound } from "../src/channels/rules.js";
import type { ChannelBackend, InboundMessage, OutboundBody, SentMessage } from "../src/channels/types.js";

/** A backend that carries nothing and remembers everything it was asked to carry. */
class Recorder implements ChannelBackend {
  readonly delivered: Array<{ to: string; body: OutboundBody }> = [];
  constructor(
    readonly name = "recorder",
    readonly live = false,
    private readonly inbox: InboundMessage[] = [],
  ) {}
  async open(): Promise<void> {}
  async next(): Promise<InboundMessage | undefined> {
    return this.inbox.shift();
  }
  async deliver(to: string, body: OutboundBody): Promise<SentMessage> {
    this.delivered.push({ to, body });
    return { id: `rec_${this.delivered.length}`, state: "sent" };
  }
  async close(): Promise<void> {}
}

const CONTACT = "+5511987654321";
const INSIDE = new Date("2026-09-23T14:00:00-03:00");
const OUTSIDE = new Date("2026-09-23T22:30:00-03:00");
const HOURS = { window: "08:00-20:00", timezone: "America/Sao_Paulo" };

function channelAt(now: Date, backend = new Recorder(), openSession = true) {
  const channel = new WhatsAppChannel({
    backend,
    conversation: { contact: CONTACT, subject: "acordo-1042" },
    now: () => now,
    hours: HOURS,
    knownSubjects: ["acordo-1042", "acordo-1077", "acordo-1103"],
    templates: [{ name: "cobranca_lembrete", language: "pt_BR", description: "a reminder", body: "Oi {{1}}, sobre o acordo." }],
  });
  // A session is open because the person wrote; the window is WhatsApp's rule, not ours, and has its own test below.
  if (openSession) {
    (channel as unknown as { session: { observeInbound(t: number): void } }).session.observeInbound(Math.floor(now.getTime() / 1000));
  }
  return { channel, backend };
}

describe("the collection rules, tried through the channel", () => {
  it("sends inside the collection hours", async () => {
    const { channel, backend } = channelAt(INSIDE);
    const sent = await channel.say("Oi, Joana! Sobre o pedido #1042.");
    expect(sent.refused).toBeUndefined();
    expect(backend.delivered).toHaveLength(1);
  });

  it("refuses everything outside the collection hours, and the backend never sees it", async () => {
    const { channel, backend } = channelAt(OUTSIDE);
    const sent = await channel.say("Oi, Joana! Sobre o pedido #1042.");
    expect(sent.refused?.rule).toBe("collection_hours");
    expect(sent.state).toBe("failed");
    expect(backend.delivered).toHaveLength(0);
  });

  it("refuses a message to any contact but the one the conversation is bound to", () => {
    const refusal = checkOutbound("+5511900000000", { kind: "text", text: "sobre a sua divida" }, {
      conversation: { contact: CONTACT, subject: "acordo-1042" },
      hours: HOURS,
      now: () => INSIDE,
    });
    expect(refusal?.rule).toBe("bound_contact");
  });

  it("refuses a message that names another debtor's agreement", async () => {
    const { channel, backend } = channelAt(INSIDE);
    const sent = await channel.say("O acordo-1077 do Carlos tambem esta em aberto, voces podem combinar.");
    expect(sent.refused?.rule).toBe("subject_scope");
    expect(backend.delivered).toHaveLength(0);
  });

  it("refuses a CPF or a CNPJ in a message, formatted or bare", async () => {
    for (const text of ["confirma o CPF 111.444.777-35?", "o CPF do titular e 11144477735", "CNPJ 12.345.678/0001-95", "CNPJ 12345678000195"]) {
      const { channel, backend } = channelAt(INSIDE);
      const sent = await channel.say(text);
      expect(sent.refused?.rule, text).toBe("no_document");
      expect(backend.delivered).toHaveLength(0);
    }
  });

  it("does NOT read a Pix copy-and-paste or a boleto line as a document", async () => {
    const { channel, backend } = channelAt(INSIDE);
    const brcode = "00020126580014br.gov.bcb.pix0136stub-chg_abc5204000053039865802BR5909CODESPAR6009SAO PAULO62070503***6304STUB";
    const bankLine = "78517596684364082005302425802108566187285620000";
    expect((await channel.send({ kind: "instrument", instrument: "pix_copy_paste", value: brcode })).refused).toBeUndefined();
    expect((await channel.send({ kind: "instrument", instrument: "boleto_bank_line", value: bankLine })).refused).toBeUndefined();
    expect(backend.delivered).toHaveLength(2);
  });

  it("refuses an empty message", async () => {
    const { channel } = channelAt(INSIDE);
    expect((await channel.say("   ")).refused?.rule).toBe("empty_message");
  });

  it("masks the contact everywhere it is written down", async () => {
    const { channel } = channelAt(INSIDE);
    await channel.say("Oi!");
    for (const line of channel.log()) {
      expect(line.contact).not.toContain("987654321");
      expect(line.contact).toContain("****");
    }
  });

  it("applies the same rules through a different backend: a backend is not a way around one", async () => {
    const other = new Recorder("another-backend", true);
    const { channel, backend } = channelAt(OUTSIDE, other);
    expect((await channel.say("boa noite, sobre a sua divida")).refused?.rule).toBe("collection_hours");
    expect((await channelAt(INSIDE, new Recorder("another-backend", true)).channel.say("CPF 11144477735")).refused?.rule).toBe("no_document");
    expect(backend.delivered).toHaveLength(0);
  });
});

describe("WhatsApp's own rule: the 24-hour session window", () => {
  it("carries a free-form message while the window is open", async () => {
    const { channel, backend } = channelAt(INSIDE);
    expect((await channel.say("Oi, Joana!")).refused).toBeUndefined();
    expect(backend.delivered).toHaveLength(1);
  });

  it("refuses a free-form message once the window has shut, and says what would carry", async () => {
    const { channel, backend } = channelAt(INSIDE, new Recorder(), false);
    const sent = await channel.say("Recebemos, acordo quitado.");
    expect(sent.refused?.rule).toBe("session_window_closed");
    expect(sent.refused?.detail).toContain("template");
    expect(backend.delivered).toHaveLength(0);
  });

  it("carries a declared template with the window shut", async () => {
    const { channel, backend } = channelAt(INSIDE, new Recorder(), false);
    const sent = await channel.send({ kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana"] });
    expect(sent.refused).toBeUndefined();
    expect(backend.delivered).toHaveLength(1);
  });

  it("refuses a template the agent never declared: Meta only delivers the ones it approved", async () => {
    const { channel, backend } = channelAt(INSIDE, new Recorder(), false);
    const sent = await channel.send({ kind: "template", template: "nao_registrado", language: "pt_BR", variables: [] });
    expect(sent.refused?.rule).toBe("template_unknown");
    expect(backend.delivered).toHaveLength(0);
  });

  it("holds a template to the house rules too: an approved template is not a way past the hours", async () => {
    const { channel, backend } = channelAt(OUTSIDE, new Recorder(), false);
    const sent = await channel.send({ kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana"] });
    expect(sent.refused?.rule).toBe("collection_hours");
    expect(backend.delivered).toHaveLength(0);
  });

  it("reopens the window when the person writes again", async () => {
    const backend = new Recorder("recorder", false, [{ id: "in_1", from: CONTACT, text: "oi", timestamp: Math.floor(INSIDE.getTime() / 1000) }]);
    const { channel } = channelAt(INSIDE, backend, false);
    expect((await channel.say("antes")).refused?.rule).toBe("session_window_closed");
    await channel.next();
    expect((await channel.say("depois")).refused).toBeUndefined();
  });
});
