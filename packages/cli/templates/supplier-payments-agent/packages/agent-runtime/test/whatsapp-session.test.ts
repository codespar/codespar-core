/**
 * The 24-hour window, read back and reasoned about.
 *
 * Two things are under test and they are the two halves of issue #25. A
 * conversation that a later process comes back to has to know where its
 * window stood, and the only honest source for that is the PROVIDER's
 * timestamp in the record — not the run's own clock, which belongs to a
 * machine WhatsApp never consulted. And a message that may only go as a
 * template has to be held to what the agent actually declared, because a
 * template Meta never approved is not a message, it is a 4xx.
 *
 * None of it needs the emulator: every refusal here happens above the
 * backend, which is the whole claim `channels/` makes.
 */
import { describe, expect, it } from "vitest";
import { templateArity, type WhatsAppTemplate } from "@codespar/agent-core";
import { WhatsAppChannel } from "../src/channels/whatsapp/index.js";
import { SessionWindow, sessionStateFromChannelLog, SESSION_WINDOW_SECONDS } from "../src/channels/whatsapp/session.js";
import type { ChannelBackend, InboundMessage, OutboundBody, SentMessage } from "../src/channels/types.js";

class Recorder implements ChannelBackend {
  readonly name = "recorder";
  readonly live = false;
  readonly delivered: OutboundBody[] = [];
  async open(): Promise<void> {}
  async next(): Promise<InboundMessage | undefined> {
    return undefined;
  }
  async deliver(_to: string, body: OutboundBody): Promise<SentMessage> {
    this.delivered.push(body);
    return { id: `rec_${this.delivered.length}`, state: "sent" };
  }
  async close(): Promise<void> {}
}

const CONTACT = "+5511987654321";
const TUESDAY = new Date("2026-09-23T14:00:00-03:00");
const FRIDAY = new Date("2026-09-25T14:00:00-03:00");
const QUITADO: WhatsAppTemplate = { name: "acordo_quitado", language: "pt_BR", description: "paid", body: "Recebemos o pagamento do {{1}}." };

function channel(now: Date, lastInboundAt?: number, backend = new Recorder()) {
  const c = new WhatsAppChannel({
    backend,
    conversation: { contact: CONTACT, subject: "acordo-1042" },
    now: () => now,
    templates: [QUITADO],
    ...(lastInboundAt !== undefined ? { session: { lastInboundAt } } : {}),
  });
  return { channel: c, backend };
}

describe("where the window stood, read back from the record", () => {
  it("takes the provider's timestamp and never the line's own `at`", () => {
    const state = sessionStateFromChannelLog([
      { direction: "in", at: "2020-01-01T00:00:00.000Z", provider_timestamp: 1790182801 },
      { direction: "out", at: "2026-09-23T17:00:10.000Z" },
      { direction: "in", at: "2020-01-01T00:00:00.000Z", provider_timestamp: 1790182821 },
    ]);
    expect(state.lastInboundAt).toBe(1790182821);
  });

  it("yields nothing from a log whose inbound lines carry no provider timestamp, and the window then reads as shut", () => {
    // A bundle written before the timestamp was recorded. Shut is the safe
    // direction: a template is deliverable in both halves of the rule.
    const state = sessionStateFromChannelLog([{ direction: "in", at: "2026-09-23T17:00:00.000Z", text: "oi" }]);
    expect(state.lastInboundAt).toBeUndefined();
    expect(new SessionWindow([], state).open(TUESDAY)).toBe(false);
  });

  it("ignores outbound lines: the window is opened by the PERSON writing, not by us", () => {
    expect(sessionStateFromChannelLog([{ direction: "out", provider_timestamp: 1790182801 }]).lastInboundAt).toBeUndefined();
  });
});

describe("a conversation a later process comes back to", () => {
  it("writes freely when the restored window is still open", async () => {
    const { channel: c, backend } = channel(TUESDAY, Math.floor(TUESDAY.getTime() / 1000) - 3600);
    expect(c.sessionOpen).toBe(true);
    expect(c.sessionRemainingSeconds).toBe(SESSION_WINDOW_SECONDS - 3600);
    const sent = await c.say("Recebemos, acordo quitado.");
    expect(sent.refused).toBeUndefined();
    expect(backend.delivered).toHaveLength(1);
  });

  it("refuses free text once the restored window has shut, which is the case the poll exists for", async () => {
    const { channel: c, backend } = channel(FRIDAY, Math.floor(TUESDAY.getTime() / 1000));
    expect(c.sessionOpen).toBe(false);
    const sent = await c.say("Recebemos, acordo quitado.");
    expect(sent.refused?.rule).toBe("session_window_closed");
    expect(backend.delivered).toHaveLength(0);
  });

  it("carries the declared template in the same breath, with the language the registry holds", async () => {
    const { channel: c, backend } = channel(FRIDAY, Math.floor(TUESDAY.getTime() / 1000));
    const declared = c.declaredTemplate("acordo_quitado");
    expect(declared?.language).toBe("pt_BR");
    const sent = await c.send({ kind: "template", template: declared!.name, language: declared!.language, variables: ["acordo-1042"] });
    expect(sent.refused).toBeUndefined();
    expect(backend.delivered).toEqual([{ kind: "template", template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] }]);
  });

  it("reads as shut when nothing restored it: a process with no record of the conversation assumes the worst", () => {
    expect(channel(TUESDAY).channel.sessionOpen).toBe(false);
  });
});

describe("the local registry refuses what Meta would refuse", () => {
  it("a name the agent never declared", async () => {
    const { channel: c, backend } = channel(FRIDAY, Math.floor(TUESDAY.getTime() / 1000));
    const sent = await c.send({ kind: "template", template: "nao_registrado", language: "pt_BR", variables: [] });
    expect(sent.refused?.rule).toBe("template_unknown");
    expect(backend.delivered).toHaveLength(0);
  });

  it("a language the template was not registered in: an approved template does not exist in another", async () => {
    const { channel: c, backend } = channel(FRIDAY, Math.floor(TUESDAY.getTime() / 1000));
    const sent = await c.send({ kind: "template", template: "acordo_quitado", language: "es_MX", variables: ["acordo-1042"] });
    expect(sent.refused?.rule).toBe("template_language_unknown");
    expect(backend.delivered).toHaveLength(0);
  });

  it("a variable count the body has no placeholders for", async () => {
    const { channel: c, backend } = channel(FRIDAY, Math.floor(TUESDAY.getTime() / 1000));
    const sent = await c.send({ kind: "template", template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042", "a mais"] });
    expect(sent.refused?.rule).toBe("template_variables_mismatch");
    expect(sent.refused?.detail).toContain("takes 1 variable(s)");
    expect(backend.delivered).toHaveLength(0);
  });

  it("counts the placeholders the way Meta numbers them", () => {
    expect(templateArity("nenhuma")).toBe(0);
    expect(templateArity("Oi {{1}}, sobre o {{2}}.")).toBe(2);
    expect(templateArity("Oi {{ 1 }}.")).toBe(1);
  });
});
