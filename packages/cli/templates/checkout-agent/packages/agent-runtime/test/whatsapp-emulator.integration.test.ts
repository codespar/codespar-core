/**
 * What the emulator does, measured rather than assumed — and what it does NOT
 * do, which is the more useful half.
 *
 * These run against `dyvit-wa-sim` (https://github.com/fabianocruz/whatsapp-simulator,
 * MIT) at the version `scripts/whatsapp-emulator.mjs` pins. They SKIP when it is
 * not listening, so `npm test` is green on a machine that never started it; the
 * CI starts it, and `npm run whatsapp:gate` fails loudly rather than skipping,
 * so nothing important hides behind a skip.
 *
 * Two kinds of assertion live here and they are not the same thing.
 *
 *   What the emulator gets RIGHT, which our adapter depends on: the Cloud API
 *   response shape, the signed webhook, the controllable clock. If one of these
 *   breaks, our channel breaks.
 *
 *   What 0.2.0 closed of the five gaps §46 of `docs/OPEN_QUESTIONS.md` measured
 *   against 0.1.1, and what 0.3.0 changed of the four places 0.2.0 differed
 *   from its own release note, plus the clock and the reset
 *   (fabianocruz/whatsapp-simulator#2). Each is asked of the PUBLISHED binary
 *   in the form that goes red if the behaviour moves back — a refusal is
 *   checked for what it did NOT do (record, webhook, bill) as well as for what
 *   it answered, because a 400 that still recorded the message would be the
 *   old gap wearing a new status.
 *
 * Two cases need an emulator nobody else is talking to: "the MOST RECENT send"
 * and "reset everything" are about the whole emulator, and on a shared one
 * another run's send or another lane's conversations are part of the answer.
 * Those start a private instance of the pinned version on a free port, and
 * stop it after. `WHATSAPP_SIM_VERSION` points them at another version, which
 * is how this file is run against the previous one to show what it catches.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EMULATOR_DEFAULTS, EmulatorDriver } from "../src/channels/whatsapp/emulator.js";
import { buildSendRequest, WhatsAppCloudApi, type CloudApiConfig } from "../src/channels/whatsapp/cloud-api.js";
import { WhatsAppChannel } from "../src/channels/whatsapp/index.js";
import type { ChannelLogLine } from "../src/channels/types.js";

const URL_BASE = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";

/**
 * Probed at MODULE level, not in a `beforeAll`: `describe.skipIf` is read when
 * the file is collected, which is before any hook has run, so a flag set in a
 * hook would skip every case on a machine where the emulator is up.
 */
const up = await (async () => {
  try {
    return (await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!up) process.stderr.write(`[whatsapp] no emulator at ${URL_BASE}; its integration cases are skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

/** The version the repo pins, read from the one place that pins it; `WHATSAPP_SIM_VERSION` overrides it for a private instance. */
const PINNED = /EMULATOR_VERSION = "([^"]+)"/.exec(readFileSync(resolve(import.meta.dirname, "../../../scripts/whatsapp-emulator.mjs"), "utf8"))![1]!;
const PRIVATE_VERSION = process.env["WHATSAPP_SIM_VERSION"] ?? PINNED;

/** An emulator of our own, for the cases whose answer is about the whole emulator. */
async function privateEmulator(): Promise<{ url: string; stop: () => void }> {
  const port = await new Promise<number>((done) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
  const child = spawn("npx", ["--yes", `@dyvit/whatsapp-simulator-cli@${PRIVATE_VERSION}`, "serve", "--port", String(port), "--app-secret", "dev"], { stdio: "ignore", detached: true });
  const stop = () => {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok) return { url, stop };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`the private emulator (${PRIVATE_VERSION}) did not come up on ${port}`);
}

/** A fresh phone-number id per case, because the emulator keys a conversation on it. */
const pnid = () => `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`;
const TO = "5511987654321";

const config = (phoneNumberId: string): CloudApiConfig => ({
  baseUrl: URL_BASE,
  phoneNumberId,
  accessToken: "emulator",
  verifyToken: "emulator",
  appSecret: "dev",
  apiVersion: "v22.0",
  webhookPort: 0,
});

async function send(phoneNumberId: string, body: Parameters<typeof buildSendRequest>[2]) {
  const request = buildSendRequest(config(phoneNumberId), `+${TO}`, body);
  if ("unsupported" in request) return { status: 0, unsupported: request.unsupported, body: null as unknown };
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  return { status: response.status, unsupported: null, body: (await response.json()) as Record<string, unknown> };
}

async function raw(path: string, init?: RequestInit) {
  const response = await fetch(`${URL_BASE}${path}`, init);
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
}

describe.skipIf(!up)("what our adapter depends on, and the emulator provides", () => {
  // Free-form text goes only inside a window the person opened, at Meta and on
  // 0.2.0 alike, so these two open one first. Before 0.2.0 they passed without
  // it, which was gap (a) hiding inside the tests of what works.
  it("answers our text send with the Cloud API's own response shape", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const result = await send(id, { kind: "text", text: "Oi, Joana!" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ messaging_product: "whatsapp" });
    const messages = (result.body as { messages: Array<{ id: string; message_status: string }> }).messages;
    expect(messages[0]!.id).toMatch(/^wamid\./);
    expect(messages[0]!.message_status).toBe("accepted");
  });

  it("takes the Pix copy-and-paste as a plain text message: the string that pays goes through unchanged", async () => {
    const brcode = "00020126580014br.gov.bcb.pix0136stub-chg_abc5204000053039865802BR5909CODESPAR6009SAO PAULO62070503***6304STUB";
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const result = await send(id, { kind: "instrument", instrument: "pix_copy_paste", value: brcode });
    expect(result.status).toBe(200);
  });

  it("takes a template with its body parameters", async () => {
    const result = await send(pnid(), { kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana"] });
    expect(result.status).toBe(200);
  });

  it("has a conversation clock we can pin and move, which is the only way a 24h window ever closes in a replay", async () => {
    const driver = new EmulatorDriver(URL_BASE);
    const pinned = (await driver.pin(new Date("2026-09-23T17:00:00.000Z"))) as { now: string };
    // To the millisecond is not the contract: 0.3.0 answers a pin with the clock it now reads, which can already be a millisecond on.
    expect(Math.abs(Date.parse(pinned.now) - Date.parse("2026-09-23T17:00:00.000Z"))).toBeLessThan(1000);
    const moved = (await driver.advanceHours(26)) as { now: string };
    expect(Date.parse(moved.now) - Date.parse(pinned.now)).toBeGreaterThanOrEqual(26 * 3600 * 1000);
  });

  it("delivers an inbound message as a webhook our own parser reads", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi, recebi a mensagem" });
    const { body } = await raw("/_sim/webhooks");
    const deliveries = (body as { deliveries: Array<{ body: unknown }> }).deliveries;
    const mine = deliveries.map((d) => d.body).filter((b) => JSON.stringify(b).includes(id));
    expect(mine.length).toBeGreaterThan(0);
  });
});

/** Every webhook the emulator has dispatched, in order. The index a redelivery names is the position here. */
async function deliveries(): Promise<Array<{ body: unknown; replayOf?: number }>> {
  return ((await raw("/_sim/webhooks")).body as { deliveries: Array<{ body: unknown; replayOf?: number }> }).deliveries;
}

async function post(path: string, body: unknown) {
  return raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

type Conversation = { messages: Array<{ id: string; bodyPreview?: string; status?: string }>; priced: { total: number; byMessageId: Record<string, { reasonCode: string }> } };

async function conversation(key: string): Promise<Conversation> {
  return (await raw(`/_sim/state?key=${encodeURIComponent(key)}`)).body as unknown as Conversation;
}

/** The inbound messages one delivery carries, the way Meta shapes them. */
function inboundOf(delivery: { body: unknown }) {
  const body = delivery.body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<Record<string, unknown>> } }> }> };
  return body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
}

describe.skipIf(!up)("the five gaps 0.2.0 closed, and what 0.3.0 changed in them, asked of the binary", () => {
  it("(a) refuses a free-form message outside the 24h window with Meta's 131047, records nothing and fires no webhook", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    expect((await send(id, { kind: "text", text: "dentro da janela" })).status).toBe(200);

    await driver.advanceHours(26);
    const before = await conversation(`${id}:${TO}`);
    const hooksBefore = (await deliveries()).length;
    const outside = await send(id, { kind: "text", text: "Recebemos, acordo quitado." });
    expect(outside.status).toBe(400);
    const error = (outside.body as { error: { code: number; error_data: { details: string } } }).error;
    expect(error.code).toBe(131047);
    expect(error.error_data.details).toMatch(/window/);
    // Refused, not recorded-and-refused: no message and no webhook.
    const after = await conversation(`${id}:${TO}`);
    expect(after.messages.map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
    expect(after.messages.some((m) => m.bodyPreview === "Recebemos, acordo quitado.")).toBe(false);
    expect((await deliveries()).length).toBe(hooksBefore);

    // The rule, not a blanket refusal: a template in the same shut window goes.
    expect((await send(id, { kind: "template", template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] })).status).toBe(200);
  });

  it("(a) and our adapter reads that refusal as the window rule, which is what lets the poll answer it with a template", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    await driver.advanceHours(26);
    const backend = new WhatsAppCloudApi({ config: config(id), conversation: { contact: `+${TO}` }, say: () => undefined });
    const sent = await backend.deliver(`+${TO}`, { kind: "text", text: "Recebemos, acordo quitado." });
    expect(sent.state).toBe("failed");
    expect(sent.refused?.rule).toBe("session_window_closed");
    expect(sent.refused?.detail).toContain("131047");
  });

  it("(b) redelivers one webhook: the same body, marked `replayOf`, appended under a NEW index", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const list = await deliveries();
    const index = list.length - 1;
    expect(JSON.stringify(list[index]!.body)).toContain(id);

    const { status, body } = await post(`/_sim/webhooks/${index}/redeliver`, {});
    expect(status).toBe(200);
    expect((body as { delivery: { replayOf: number } }).delivery.replayOf).toBe(index);

    // Gotcha one: the redelivery is itself a delivery, at the end of the list.
    const after = await deliveries();
    expect(after.length).toBe(list.length + 1);
    expect(after[after.length - 1]!.replayOf).toBe(index);
    // A duplicate, which is what Meta sends: same message id, not a second message.
    expect(after[after.length - 1]!.body).toEqual(list[index]!.body);
  });

  it("(b) replays several in the order asked, duplicates included, so out-of-order delivery can be driven", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "primeira" });
    const a = (await deliveries()).length - 1;
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "segunda" });
    const b = (await deliveries()).length - 1;
    const before = (await deliveries()).length;

    const { status } = await post("/_sim/replay", { indexes: [b, a, a] });
    expect(status).toBe(200);
    const replayed = (await deliveries()).slice(before);
    expect(replayed.map((d) => d.replayOf)).toEqual([b, a, a]);
    expect(replayed.map((d) => (inboundOf(d)[0]!["text"] as { body: string }).body)).toEqual(["segunda", "primeira", "primeira"]);
  });

  it("(b) since 0.3.0 a replay checks every index first: one missing answers 404, NOTHING goes out, and the count named is the list before the call", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const a = (await deliveries()).length - 1;
    const before = (await deliveries()).length;
    const missing = before + 1000;

    const { status, body } = await post("/_sim/replay", { indexes: [a, missing, a] });
    expect(status).toBe(404);
    // 0.2.0 redelivered the ones before the missing index and counted the list after them.
    expect((body as { error: { message: string } }).error.message).toContain(`there are ${before} `);
    expect((await deliveries()).length).toBe(before);
  });

  it("(b) and our receiver hands a redelivered message on once, which is what Meta's at-least-once delivery needs of it", async () => {
    const id = pnid();
    const backend = new WhatsAppCloudApi({ config: { ...config(id), webhookPort: EMULATOR_DEFAULTS.webhookPort }, conversation: { contact: `+${TO}` }, say: () => undefined });
    await backend.open();
    try {
      await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "fechado, pago à vista" });
      const index = (await deliveries()).length - 1;
      const redelivered = await post(`/_sim/webhooks/${index}/redeliver`, {});
      // Signed like the original, so it reached us and was verified — the drop below is ours, not a bad signature.
      expect((redelivered.body as { delivery: { status: number } }).delivery.status).toBe(200);
      expect((await backend.next())?.text).toBe("fechado, pago à vista");
      const second = await Promise.race([backend.next(), new Promise((resolve) => setTimeout(() => resolve("nothing"), 300))]);
      expect(second).toBe("nothing");
    } finally {
      await backend.close();
    }
  });

  it("(c) keys a conversation on the digits: `+55…` inbound and `55…` outbound are one person, and a `+` key still finds it", async () => {
    const id = pnid();
    // By hand, with the `+` Meta never sends and the emulator's own default uses.
    await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, text: "oi" });
    await send(id, { kind: "text", text: "resposta" });
    const keys = ((await raw(`/_sim/state?key=${id}:not-a-conversation`)).body as { keys: string[] }).keys;
    expect(keys.filter((k) => k.startsWith(`${id}:`))).toEqual([`${id}:${TO}`]);
    const withPlus = await conversation(`${id}:+${TO}`);
    expect(withPlus.messages.map((m) => m.bodyPreview)).toEqual(["oi", "resposta"]);
    // And the inbound webhook carries `from` the way Meta does, without the `+`.
    const mine = (await deliveries()).filter((d) => JSON.stringify(d.body).includes(id)).flatMap(inboundOf);
    expect(mine.map((m) => m["from"])).toEqual([TO]);
  });

  it("(d) emits `read` and `failed` on demand; a failure carries 131026 and leaves the bill", async () => {
    const id = pnid();
    const key = `${id}:${TO}`;
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    await driver.advanceHours(26);
    // Two templates outside the window, both billed, so the total can visibly rise and then fall.
    const template = { kind: "template" as const, template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] };
    const first = ((await send(id, template)).body as { messages: Array<{ id: string }> }).messages[0]!.id;
    await send(id, template);
    const billed = (await conversation(key)).priced.total;
    expect(billed).toBeGreaterThan(0);

    const statusesFor = async (message: string) =>
      (await deliveries())
        .map((d) => d.body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string; errors?: Array<{ code: number; error_data?: { details?: string } }> }> } }> }> })
        .flatMap((b) => b.entry?.[0]?.changes?.[0]?.value?.statuses ?? [])
        .filter((s) => s.id === message);

    const second = (await conversation(key)).messages.at(-1)!.id;
    expect((await post("/_sim/status", { status: "read", message_id: first })).status).toBe(200);
    expect((await statusesFor(first)).map((s) => s.status)).toEqual(["sent", "delivered", "read"]);

    expect((await post("/_sim/status", { status: "failed", reason: "not on whatsapp", message_id: second })).status).toBe(200);
    const failed = (await statusesFor(second)).at(-1)!;
    expect(failed.status).toBe("failed");
    expect(failed.errors?.[0]?.code).toBe(131026);
    expect(failed.errors?.[0]?.error_data?.details).toBe("not on whatsapp");

    const after = await conversation(key);
    expect(after.priced.byMessageId[second]!.reasonCode).toBe("NOT_BILLABLE_FAILED");
    expect(after.priced.total).toBeLessThan(billed);
    expect(after.priced.total).toBeGreaterThan(0);
  });

  it("(e) carries an interactive reply through as Meta's `interactive` object, id preserved, and refuses one without an id", async () => {
    const id = pnid();
    const replies = [
      { type: "button_reply", button_reply: { id: "avista", title: "À vista" } },
      // 0.3.0: `description` goes through as Meta sends it; 0.2.0 dropped it.
      { type: "list_reply", list_reply: { id: "3x", title: "3x", description: "tres parcelas de R$ 400,00" } },
      { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: '{"plano":"3x"}' } },
    ];
    for (const interactive of replies) {
      expect((await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive })).status).toBe(200);
      const last = inboundOf((await deliveries()).at(-1)!)[0]!;
      expect(last["type"]).toBe("interactive");
      expect(last["interactive"]).toEqual(interactive);
    }

    const before = (await deliveries()).length;
    const noId = await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive: { type: "button_reply", button_reply: { title: "À vista" } } });
    expect(noId.status).toBe(400);
    const noJson = await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow" } } });
    expect(noJson.status).toBe(400);
    expect((await deliveries()).length).toBe(before);
  });
});

/** The statuses one delivery carries, the way Meta shapes them. */
function statusesOf(delivery: { body: unknown }) {
  const body = delivery.body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string }> } }> }> };
  return body.entry?.[0]?.changes?.[0]?.value?.statuses ?? [];
}

describe.skipIf(!up)("what 0.3.0 changed, asked of the binary (§46, fabianocruz/whatsapp-simulator#2)", () => {
  it("1. a status with neither key nor message_id marks the MOST RECENT send, in whichever conversation it went", { timeout: 60_000 }, async () => {
    const own = await privateEmulator();
    try {
      const at = (path: string, body: unknown) => fetch(`${own.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = (id: string, body: string) => at(`/v22.0/${id}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: TO, type: "text", text: { preview_url: false, body } });
      const first = pnid();
      const second = pnid();
      // The FIRST conversation the emulator holds is not the one that sent last: 0.2.0 marked the first one's last message.
      await at("/_sim/inbound", { phone_number_id: first, from: `+${TO}`, text: "oi" });
      await at("/_sim/inbound", { phone_number_id: second, from: `+${TO}`, text: "oi" });
      await text(first, "a primeira conversa responde");
      const latest = ((await (await text(second, "a segunda responde por ultimo")).json()) as { messages: Array<{ id: string }> }).messages[0]!.id;

      expect((await at("/_sim/status", { status: "read" })).status).toBe(200);
      const state = async (id: string) => (await (await fetch(`${own.url}/_sim/state?key=${id}:${TO}`)).json()) as { messages: Array<{ id: string; status: string; direction: string }> };
      expect((await state(second)).messages.find((m) => m.id === latest)?.status).toBe("read");
      expect((await state(first)).messages.filter((m) => m.direction === "business_to_user").map((m) => m.status)).not.toContain("read");
    } finally {
      own.stop();
    }
  });

  it("2. only read and failed can be injected, and both are final: delivered is 400, failed after read is 409 and leaves the bill", async () => {
    const id = pnid();
    const key = `${id}:${TO}`;
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    await driver.advanceHours(26);
    const template = { kind: "template" as const, template: "acordo_quitado", language: "pt_BR", variables: ["acordo-1042"] };
    const message = ((await send(id, template)).body as { messages: Array<{ id: string }> }).messages[0]!.id;

    const delivered = await post("/_sim/status", { status: "delivered", message_id: message });
    expect(delivered.status).toBe(400);
    expect((await post("/_sim/status", { status: "read", message_id: message })).status).toBe(200);
    const billed = (await conversation(key)).priced.total;
    const hooks = (await deliveries()).length;

    const afterRead = await post("/_sim/status", { status: "failed", reason: "not on whatsapp", message_id: message });
    expect(afterRead.status).toBe(409);
    expect((await post("/_sim/status", { status: "read", message_id: message })).status).toBe(409);
    const after = await conversation(key);
    expect(after.priced.total).toBe(billed);
    expect(after.priced.byMessageId[message]!.reasonCode).not.toBe("NOT_BILLABLE_FAILED");
    expect(after.messages.find((m) => m.id === message)?.status).toBe("read");
    expect((await deliveries()).length).toBe(hooks);
  });

  it("3. a list_reply keeps its description in the webhook, the way Meta sends it", async () => {
    const id = pnid();
    const interactive = { type: "list_reply", list_reply: { id: "3x", title: "3x", description: "tres parcelas de R$ 400,00" } };
    expect((await post("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, type: "interactive", interactive })).status).toBe(200);
    const last = inboundOf((await deliveries()).at(-1)!)[0]!;
    expect((last["interactive"] as { list_reply: { description?: string } }).list_reply.description).toBe("tres parcelas de R$ 400,00");
  });

  it("4. a replay with one bad index sends nothing at all", async () => {
    const id = pnid();
    await new EmulatorDriver(URL_BASE).inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    const a = (await deliveries()).length - 1;
    const before = await deliveries();
    const { status } = await post("/_sim/replay", { indexes: [a, a, before.length + 1000] });
    expect(status).toBe(404);
    const after = await deliveries();
    expect(after.length).toBe(before.length);
    expect(after.filter((d) => d.replayOf === a).length).toBe(before.filter((d) => d.replayOf === a).length);
  });

  it("5. a clock moved back before existing messages warns and names them; their window still counts, as Meta's would", async () => {
    const id = pnid();
    const key = `${id}:${TO}`;
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-24T01:30:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi, as 22:30" });
    const back = (await driver.pin(new Date("2026-09-23T17:00:00.000Z"))) as { warning?: string; ahead?: Array<{ key: string; latest: string }> };
    expect(back.warning).toMatch(/reset/);
    expect(back.ahead?.map((x) => x.key)).toContain(key);
    expect(back.ahead?.find((x) => x.key === key)?.latest.startsWith("2026-09-24T01:30")).toBe(true);
    // The window is still counted from the message "ahead": 26 hours on from the pinned 17:00 is inside it. That is #42, named, not fixed.
    await driver.advanceHours(26);
    expect((await send(id, { kind: "text", text: "janela?" })).status).toBe(200);
  });

  it("6. reset by key clears that conversation and only it, so its window counts from what happens next", async () => {
    const id = pnid();
    const other = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.inbound({ phoneNumberId: other, from: `+${TO}`, text: "a outra conversa fica" });
    await driver.pin(new Date("2026-09-24T01:30:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi, as 22:30" });

    const reset = await post("/_sim/reset", { key: `${id}:${TO}` });
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ key: `${id}:${TO}`, removed: true });
    expect((await raw(`/_sim/state?key=${encodeURIComponent(`${id}:${TO}`)}`)).status).toBe(404);
    expect((await conversation(`${other}:${TO}`)).messages.map((m) => m.bodyPreview)).toEqual(["a outra conversa fica"]);

    // The #42 sequence, cleared: back to 17:00, the person writes, 26 hours pass, and the window is shut.
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi, as 14:00" });
    await driver.advanceHours(26);
    const outside = await send(id, { kind: "text", text: "janela?" });
    expect(outside.status).toBe(400);
    expect((outside.body as { error: { code: number } }).error.code).toBe(131047);
  });

  it("6. reset with no key clears the whole emulator: conversations, webhooks and the clock", { timeout: 60_000 }, async () => {
    // Never on a shared emulator: this is exactly what the per-run conversation of #42 exists not to need.
    const own = await privateEmulator();
    try {
      const at = (path: string, body: unknown) => fetch(`${own.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const id = pnid();
      await at("/_sim/inbound", { phone_number_id: id, from: `+${TO}`, text: "oi" });
      await at("/_sim/clock", { advance_hours: 100 });
      expect(((await (await fetch(`${own.url}/_sim/webhooks`)).json()) as { deliveries: unknown[] }).deliveries.length).toBeGreaterThan(0);

      const reset = await at("/_sim/reset", {});
      expect(reset.status).toBe(200);
      expect(((await (await fetch(`${own.url}/_sim/webhooks`)).json()) as { deliveries: unknown[] }).deliveries).toEqual([]);
      expect((await fetch(`${own.url}/_sim/state?key=${id}:${TO}`)).status).toBe(404);
      const clock = (await (await at("/_sim/clock", { advance_hours: 0 })).json()) as { now: string };
      expect(Math.abs(Date.parse(clock.now) - Date.now())).toBeLessThan(60_000);
    } finally {
      own.stop();
    }
  });
});

describe.skipIf(!up)("§46's three product gaps, against the binary: statuses, taps and the template's buttons", () => {
  const templates = [
    { name: "acordo_quitado", language: "pt_BR", description: "paid", body: "Oi! {{1}} quitado." },
    { name: "acordo_cobranca_vencida", language: "pt_BR", description: "expired", body: "Oi! A cobranca do {{1}} venceu.", buttons: [{ id: "emitir_nova", title: "Emitir nova", intent: "quero que voce emita uma nova cobranca para o meu acordo" }] },
  ];

  /** Our channel over our receiver, on the port the emulator delivers to, in a conversation of its own. */
  async function opened() {
    const id = pnid();
    const failed: ChannelLogLine[] = [];
    const backend = new WhatsAppCloudApi({ config: { ...config(id), webhookPort: EMULATOR_DEFAULTS.webhookPort }, conversation: { contact: `+${TO}` }, say: () => undefined });
    const channel = new WhatsAppChannel({ backend, conversation: { contact: `+${TO}` }, now: () => new Date(), templates, onDeliveryFailed: (l) => failed.push(l) });
    await channel.open();
    const driver = new EmulatorDriver(URL_BASE);
    // The emulator's clock and ours agree for this conversation, so the window our channel reads is the one the provider enforces.
    await driver.pin(new Date());
    return { id, channel, failed, driver };
  }

  async function until(check: () => boolean, ms = 4000): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 50) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  }

  it("a failed status injected at the emulator reaches our receiver as 131026, tied to the outcome the message told", async () => {
    const { id, channel, failed, driver } = await opened();
    try {
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
      await channel.next();
      const sent = await channel.send({ kind: "text", text: "Recebemos, acordo quitado.", about: { execution_id: "exe_x", state: "settled" } });
      expect(sent.state).toBe("sent");
      await driver.status({ status: "failed", messageId: sent.id, reason: "not on whatsapp" });
      expect(await until(() => channel.deliveryOf(sent.id) === "failed")).toBe(true);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ direction: "status", message_id: sent.id, about: { execution_id: "exe_x", state: "settled" } });
      expect(failed[0]!.errors?.[0]?.code).toBe(131026);
    } finally {
      await channel.close();
    }
  });

  it("a read reaches us too, and is recorded only", async () => {
    const { id, channel, failed, driver } = await opened();
    try {
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
      await channel.next();
      const sent = await channel.send({ kind: "text", text: "Oi!" });
      await driver.status({ status: "read", messageId: sent.id });
      expect(await until(() => channel.deliveryOf(sent.id) === "read")).toBe(true);
      expect(failed).toEqual([]);
    } finally {
      await channel.close();
    }
  });

  it("a template goes out with its quick replies, the emulator takes them, and a tap on one comes back as the declared intent", async () => {
    const { id, channel, driver } = await opened();
    try {
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
      await channel.next();
      const sent = await channel.send({ kind: "template", template: "acordo_cobranca_vencida", language: "pt_BR", variables: ["acordo-1042"] });
      expect(sent.state).toBe("sent");
      expect(channel.log().at(-1)?.offered).toEqual(["emitir_nova"]);
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, reply: { id: "emitir_nova", title: "Emitir nova" } });
      expect((await channel.next())?.text).toBe("quero que voce emita uma nova cobranca para o meu acordo");
      // And a tap on something nobody offered is not a turn: the next one the channel hands on is the text after it.
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, reply: { id: "pagar_tudo", title: "Pagar tudo" } });
      await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "e agora?" });
      expect((await channel.next())?.text).toBe("e agora?");
      expect(channel.log().filter((l) => l.kind === "reply").map((l) => [l.reply?.id, l.refused?.rule ?? null])).toEqual([["emitir_nova", null], ["pagar_tudo", "reply_not_offered"]]);
    } finally {
      await channel.close();
    }
  });
});
