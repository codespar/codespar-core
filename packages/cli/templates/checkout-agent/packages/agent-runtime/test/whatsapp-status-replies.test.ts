/**
 * §46's three product gaps, as the channel now answers them, with no network:
 * a status webhook is read (a `failed` of an outcome's message is that
 * outcome NOT told), a tapped quick reply becomes a turn only as the intent a
 * declared template gave it, and the registry carries a fallback for an
 * outcome the kit has no copy for. The same behaviour against the emulator is
 * in `whatsapp-emulator.integration.test.ts`.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgent, type WhatsAppTemplate } from "@codespar/agent-core";
import { WhatsAppChannel } from "../src/channels/whatsapp/index.js";
import { buildSendRequest, parseInbound, type CloudApiConfig } from "../src/channels/whatsapp/cloud-api.js";
import type { ChannelBackend, ChannelLogLine, InboundMessage, OutboundBody, SentMessage, StatusUpdate } from "../src/channels/types.js";

const CONTACT = "+5511987654321";
const NOW = new Date("2026-09-23T17:00:00Z");

/** A backend the test drives: it queues what the person does and hands the channel the statuses the test reports. */
class Scripted implements ChannelBackend {
  readonly name = "scripted";
  readonly live = false;
  readonly delivered: OutboundBody[] = [];
  private listener: ((s: StatusUpdate) => void) | undefined;
  constructor(private readonly inbox: InboundMessage[] = []) {}
  async open(): Promise<void> {}
  async next(): Promise<InboundMessage | undefined> {
    return this.inbox.shift();
  }
  async deliver(_to: string, body: OutboundBody): Promise<SentMessage> {
    this.delivered.push(body);
    return { id: `wamid.test.${this.delivered.length}`, state: "sent" };
  }
  onStatus(listener: (s: StatusUpdate) => void): void {
    this.listener = listener;
  }
  report(status: StatusUpdate): void {
    this.listener?.(status);
  }
  async close(): Promise<void> {}
}

const TEMPLATES: WhatsAppTemplate[] = [
  { name: "acordo_quitado", language: "pt_BR", description: "paid", body: "Oi! {{1}} quitado." },
  {
    name: "acordo_cobranca_vencida",
    language: "pt_BR",
    description: "expired",
    body: "Oi! A cobranca do {{1}} venceu.",
    buttons: [
      { id: "emitir_nova", title: "Emitir nova", intent: "quero que voce emita uma nova cobranca para o meu acordo" },
      { id: "agora_nao", title: "Agora nao", intent: "agora nao quero uma nova cobranca" },
    ],
  },
  { name: "atendimento_atualizacao", language: "pt_BR", description: "fallback", body: "Oi! Temos uma atualizacao.", fallback: true },
];

function channel(inbox: InboundMessage[] = []) {
  const backend = new Scripted(inbox);
  const said: string[] = [];
  const failed: ChannelLogLine[] = [];
  const ch = new WhatsAppChannel({ backend, conversation: { contact: CONTACT, subject: "acordo-1042" }, now: () => NOW, templates: TEMPLATES, say: (l) => said.push(l), onDeliveryFailed: (l) => failed.push(l) });
  return { ch, backend, said, failed };
}

const tap = (id: string, extra: Partial<InboundMessage["reply"]> = {}): InboundMessage => ({ id: `wamid.in.${id}`, from: CONTACT, text: "Emitir nova", timestamp: 1790190000, reply: { type: "button_reply", id, title: "Emitir nova", ...extra } });

describe("1. a status webhook is read, and a failed outcome is an outcome not told", () => {
  it("parses statuses, with Meta's errors, out of the same delivery that carries messages", () => {
    const parsed = parseInbound({
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.a", status: "failed", timestamp: "1790190000", errors: [{ code: 131026, title: "Message undeliverable", error_data: { details: "not on whatsapp" } }] }, { id: "wamid.b", status: "read", timestamp: "1790190001" }, { id: "wamid.c", status: "deleted" }] } }] }],
    });
    expect(parsed.statuses).toEqual([
      { message_id: "wamid.a", status: "failed", timestamp: 1790190000, errors: [{ code: 131026, title: "Message undeliverable", details: "not on whatsapp" }] },
      { message_id: "wamid.b", status: "read", timestamp: 1790190001, errors: [] },
    ]);
  });

  it("a failed status of a message that told an outcome is recorded, reaches the operator and the outcome's owner, and names the outcome", async () => {
    const { ch, backend, said, failed } = channel();
    await ch.open();
    (ch as unknown as { session: { observeInbound(t: number): void } }).session.observeInbound(Math.floor(NOW.getTime() / 1000));
    const sent = await ch.send({ kind: "text", text: "Recebemos, acordo quitado.", about: { execution_id: "exe_1", state: "settled" } });
    backend.report({ message_id: sent.id, status: "failed", timestamp: 1790190100, errors: [{ code: 131026, details: "not on whatsapp" }] });
    expect(ch.deliveryOf(sent.id)).toBe("failed");
    const status = ch.log().find((l) => l.direction === "status")!;
    expect(status).toMatchObject({ kind: "status", message_id: sent.id, state: "failed", about: { execution_id: "exe_1", state: "settled" }, errors: [{ code: 131026, details: "not on whatsapp" }] });
    expect(failed).toEqual([status]);
    expect(said.join("\n")).toContain("a pessoa NAO foi avisada");
  });

  it("a read is recorded and nothing more: not consent, not an acknowledgement, not a reply", async () => {
    const { ch, backend, said, failed } = channel();
    await ch.open();
    (ch as unknown as { session: { observeInbound(t: number): void } }).session.observeInbound(Math.floor(NOW.getTime() / 1000));
    const sent = await ch.send({ kind: "text", text: "Recebemos.", about: { execution_id: "exe_1", state: "settled" } });
    backend.report({ message_id: sent.id, status: "read", timestamp: 1790190100, errors: [] });
    expect(ch.log().filter((l) => l.direction === "status").map((l) => l.state)).toEqual(["read"]);
    expect(failed).toEqual([]);
    expect(said).toEqual([]);
    // A read is not a turn either.
    expect(await ch.next()).toBeUndefined();
  });

  it("a failure the provider reports BEFORE the send answered (the emulator posts statuses synchronously) is still tied to its outcome", async () => {
    class Eager extends Scripted {
      override async deliver(to: string, body: OutboundBody): Promise<SentMessage> {
        const sent = await super.deliver(to, body);
        this.report({ message_id: sent.id, status: "failed", timestamp: 1, errors: [{ code: 131026 }] });
        return sent;
      }
    }
    const backend = new Eager();
    const failed: ChannelLogLine[] = [];
    const ch = new WhatsAppChannel({ backend, conversation: { contact: CONTACT }, now: () => NOW, templates: TEMPLATES, onDeliveryFailed: (l) => failed.push(l) });
    await ch.open();
    await ch.send({ kind: "template", template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"], about: { execution_id: "exe_2", state: "settled" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(failed.map((l) => l.about)).toEqual([{ execution_id: "exe_2", state: "settled" }]);
  });

  it("a status about a message an EARLIER run sent is tied back to the outcome that run recorded", async () => {
    const prior: ChannelLogLine = { at: NOW.toISOString(), direction: "out", contact: "+55*****4321", kind: "template", message_id: "wamid.old", state: "sent", about: { execution_id: "exe_old", state: "settled" } };
    const backend = new Scripted();
    const failed: ChannelLogLine[] = [];
    const ch = new WhatsAppChannel({ backend, conversation: { contact: CONTACT }, now: () => NOW, templates: TEMPLATES, priorLines: [prior], onDeliveryFailed: (l) => failed.push(l) });
    await ch.open();
    backend.report({ message_id: "wamid.old", status: "failed", timestamp: 1, errors: [{ code: 131026 }] });
    expect(failed[0]?.about).toEqual({ execution_id: "exe_old", state: "settled" });
  });
});

describe("2. a tapped quick reply is a turn, as the intent a declared template gave it", () => {
  it("parses a button_reply, a list_reply and a template's quick-reply button, id and context kept", () => {
    const msg = (m: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { messages: [{ from: "5511987654321", timestamp: "1", ...m }] } }] }] });
    expect(parseInbound(msg({ id: "a", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "emitir_nova", title: "Emitir nova" } }, context: { id: "wamid.offer" } })).messages[0]?.reply).toEqual({ type: "button_reply", id: "emitir_nova", title: "Emitir nova", context_id: "wamid.offer" });
    expect(parseInbound(msg({ id: "b", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "3x", title: "3x", description: "tres" } } })).messages[0]?.reply).toEqual({ type: "list_reply", id: "3x", title: "3x" });
    expect(parseInbound(msg({ id: "c", type: "button", button: { payload: "emitir_nova", text: "Emitir nova" } })).messages[0]?.reply).toEqual({ type: "button", id: "emitir_nova", title: "Emitir nova" });
    // What this channel cannot read is still named, not turned into an empty message.
    expect(parseInbound(msg({ id: "d", type: "image" })).ignored).toEqual([{ id: "d", type: "image" }]);
    expect(parseInbound(msg({ id: "e", type: "interactive", interactive: { type: "nfm_reply" } })).ignored).toEqual([{ id: "e", type: "interactive:nfm_reply" }]);
  });

  it("a declared id is a turn whose text is the declared intent, never the title", async () => {
    const { ch } = channel([tap("emitir_nova")]);
    const turn = await ch.next();
    expect(turn?.text).toBe("quero que voce emita uma nova cobranca para o meu acordo");
    const line = ch.log().at(-1)!;
    expect(line).toMatchObject({ direction: "in", kind: "reply", reply: { id: "emitir_nova", title: "Emitir nova" }, text: "quero que voce emita uma nova cobranca para o meu acordo" });
  });

  it("an id no template declares is not a turn: recorded, told to the operator, and the next real turn is what comes back", async () => {
    const typed: InboundMessage = { id: "wamid.in.text", from: CONTACT, text: "oi", timestamp: 1790190001 };
    const { ch, said } = channel([tap("pagar_tudo", { title: "Pagar tudo" }), typed]);
    const turn = await ch.next();
    expect(turn?.text).toBe("oi");
    expect(ch.log()[0]).toMatchObject({ kind: "reply", refused: { rule: "reply_not_offered" }, reply: { id: "pagar_tudo" } });
    expect(said.join("\n")).toContain("reply_not_offered");
  });

  it("a tap that names a message this conversation did not send with that reply is not a turn either", async () => {
    const { ch } = channel([tap("emitir_nova", { context_id: "wamid.somebody_else" })]);
    expect(await ch.next()).toBeUndefined();
    expect(ch.log()[0]?.refused?.rule).toBe("reply_not_offered");
  });

  it("a template goes out with the quick replies its declaration offers, and the log says which", async () => {
    const { ch, backend } = channel();
    await ch.send({ kind: "template", template: "acordo_cobranca_vencida", language: "pt_BR", variables: ["acordo-1042"] });
    expect((backend.delivered[0] as { buttons?: unknown }).buttons).toEqual([{ id: "emitir_nova", title: "Emitir nova" }, { id: "agora_nao", title: "Agora nao" }]);
    expect(ch.log()[0]?.offered).toEqual(["emitir_nova", "agora_nao"]);
    const config: CloudApiConfig = { baseUrl: "http://sim", phoneNumberId: "1", accessToken: "t", verifyToken: "v", appSecret: "s", apiVersion: "v22.0", webhookPort: 0 };
    const request = buildSendRequest(config, CONTACT, backend.delivered[0]!) as { body: string };
    expect(JSON.parse(request.body).template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "acordo-1042" }] },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "emitir_nova" }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "agora_nao" }] },
    ]);
  });
});

describe("3. an outcome with no template of its own: the registry declares a fallback, and check requires one", () => {
  const COLLECTIONS = resolve(import.meta.dirname, "../../../agents/collections-agent");
  const copy = () => {
    const dir = mkdtempSync(join(tmpdir(), "wa-fallback-check-"));
    cpSync(COLLECTIONS, dir, { recursive: true, filter: (src) => !/node_modules|\/runs|\.codespar/.test(src) });
    return dir;
  };
  const codes = (dir: string) => checkAgent(dir).findings.filter((f) => f.level === "error").map((f) => f.code);
  const registry = (dir: string) => join(dir, "channels/whatsapp/templates.json");
  const edit = (dir: string, fn: (templates: Array<Record<string, unknown>>) => void) => {
    const doc = JSON.parse(readFileSync(registry(dir), "utf8")) as { templates: Array<Record<string, unknown>> };
    fn(doc.templates);
    writeFileSync(registry(dir), JSON.stringify(doc));
  };

  it("the shipped agents pass", () => {
    expect(codes(COLLECTIONS)).toEqual([]);
    expect(codes(resolve(COLLECTIONS, "../checkout-agent"))).toEqual([]);
  });

  it("refuses a WhatsApp agent with no fallback, with two, and with one that takes variables", () => {
    const none = copy();
    edit(none, (t) => t.forEach((x) => delete x["fallback"]));
    expect(codes(none)).toContain("channels_templates_fallback");
    const two = copy();
    edit(two, (t) => t.forEach((x) => (x["fallback"] = true)));
    expect(codes(two)).toContain("channels_templates_fallback");
    const variables = copy();
    edit(variables, (t) => {
      const fallback = t.find((x) => x["fallback"])!;
      fallback["body"] = "Oi {{1}}, temos novidade.";
    });
    expect(codes(variables)).toContain("channels_templates_fallback");
  });

  it("refuses a conversation that taps a reply no template offers, and two templates offering the same id", () => {
    const script = copy();
    const path = join(script, "channels/whatsapp/acordo-1042.json");
    const doc = JSON.parse(readFileSync(path, "utf8")) as { turns: unknown[] };
    doc.turns.push({ reply: { id: "pagar_tudo" } });
    writeFileSync(path, JSON.stringify(doc));
    expect(codes(script)).toContain("channels_script_invalid");
    const dup = copy();
    edit(dup, (t) => {
      t[0]!["buttons"] = [{ id: "emitir_nova", title: "Outra", intent: "outra coisa" }];
    });
    expect(codes(dup)).toContain("channels_templates_invalid");
  });
});
