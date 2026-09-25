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
 *   What the emulator does NOT do, which our channel has to cover itself. Those
 *   assertions are written to FAIL the day the emulator closes the gap — which
 *   is what we want, because the pin means it can only change when we move it,
 *   and the failure is the notification. They are a spec for the repo's owner,
 *   not a complaint: `docs/OPEN_QUESTIONS.md` §46 carries the same list in
 *   prose with the payloads.
 */
import { describe, expect, it } from "vitest";
import { EmulatorDriver } from "../src/channels/whatsapp/emulator.js";
import { buildSendRequest, type CloudApiConfig } from "../src/channels/whatsapp/cloud-api.js";

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
  it("answers our text send with the Cloud API's own response shape", async () => {
    const id = pnid();
    const result = await send(id, { kind: "text", text: "Oi, Joana!" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ messaging_product: "whatsapp" });
    const messages = (result.body as { messages: Array<{ id: string; message_status: string }> }).messages;
    expect(messages[0]!.id).toMatch(/^wamid\./);
    expect(messages[0]!.message_status).toBe("accepted");
  });

  it("takes the Pix copy-and-paste as a plain text message: the string that pays goes through unchanged", async () => {
    const brcode = "00020126580014br.gov.bcb.pix0136stub-chg_abc5204000053039865802BR5909CODESPAR6009SAO PAULO62070503***6304STUB";
    const result = await send(pnid(), { kind: "instrument", instrument: "pix_copy_paste", value: brcode });
    expect(result.status).toBe(200);
  });

  it("takes a template with its body parameters", async () => {
    const result = await send(pnid(), { kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana"] });
    expect(result.status).toBe(200);
  });

  it("has a conversation clock we can pin and move, which is the only way a 24h window ever closes in a replay", async () => {
    const driver = new EmulatorDriver(URL_BASE);
    const pinned = (await driver.pin(new Date("2026-09-23T17:00:00.000Z"))) as { now: string };
    expect(pinned.now).toBe("2026-09-23T17:00:00.000Z");
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

/**
 * The gaps. Each one is the exact payload that failed, so the assertion doubles
 * as the report. They are written against the PINNED sha: a green run here
 * means the gap is still open, and a red one means it was closed and our own
 * cover for it can be reconsidered.
 */
describe.skipIf(!up)("what the emulator does not do, measured", () => {
  it("GAP: accepts a free-form message outside the 24h window that Meta refuses with 131047 — and it already knows", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    await driver.pin(new Date("2026-09-23T17:00:00.000Z"));
    await driver.inbound({ phoneNumberId: id, from: `+${TO}`, text: "oi" });
    expect((await send(id, { kind: "text", text: "dentro da janela" })).status).toBe(200);

    await driver.advanceHours(26);
    const outside = await send(id, { kind: "text", text: "Recebemos, acordo quitado." });
    // The real Cloud API answers 400 with error 131047 and sends nothing.
    expect(outside.status).toBe(200);

    // And this is what makes it a one-line fix rather than a feature: the
    // pricing engine has ALREADY decided the message is invalid there.
    const state = (await raw(`/_sim/state?key=${id}:${TO}`)).body as {
      messages: Array<{ id: string }>;
      priced: { byMessageId: Record<string, { reasonCode: string }> };
    };
    const last = state.messages[state.messages.length - 1]!;
    expect(state.priced.byMessageId[last.id]!.reasonCode).toBe("INVALID_NON_TEMPLATE_OUTSIDE_CSW");
  });

  it("GAP: has no way to redeliver or reorder a webhook, so duplicate and out-of-order delivery cannot be driven", async () => {
    for (const path of ["/_sim/replay", "/_sim/webhooks/replay", "/_sim/redeliver"]) {
      const { status } = await raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(status, path).toBe(404);
    }
    // `GET /_sim/webhooks` is a read-only log; nothing re-dispatches from it.
    const { status, body } = await raw("/_sim/webhooks");
    expect(status).toBe(200);
    expect(Array.isArray((body as { deliveries: unknown[] }).deliveries)).toBe(true);
  });

  it("GAP: an inbound interactive reply degrades to an empty text message, so a debtor cannot tap a button", async () => {
    const id = pnid();
    const { status, body } = await raw("/_sim/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone_number_id: id,
        from: `+${TO}`,
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "avista", title: "À vista" } },
      }),
    });
    expect(status).toBe(200);
    const message = (body as { message: { contentType: string; bodyPreview: string } }).message;
    // The interactive payload is dropped: outbound buttons work, the reply to one does not exist.
    expect(message.contentType).toBe("text");
    expect(message.bodyPreview).toBe("");
  });

  it("GAP: only `sent` and `delivered` are ever emitted, so a channel cannot observe a read receipt or a failure", async () => {
    const id = pnid();
    await send(id, { kind: "text", text: "uma mensagem" });
    const { body } = await raw("/_sim/webhooks");
    const statuses = (body as { deliveries: Array<{ body: unknown }> }).deliveries
      .map((d) => d.body as { entry?: Array<{ id?: string; changes?: Array<{ value?: { statuses?: Array<{ status: string }> } }> }> })
      .filter((b) => b.entry?.[0]?.id === id)
      .flatMap((b) => b.entry?.[0]?.changes?.[0]?.value?.statuses ?? [])
      .map((s) => s.status);
    expect(statuses).toEqual(["sent", "delivered"]);
  });

  it("GAP: a `+` on one side and none on the other splits one person into two conversations", async () => {
    const id = pnid();
    const driver = new EmulatorDriver(URL_BASE);
    // Our driver strips the `+` precisely to avoid this; done by hand here, it splits.
    await raw("/_sim/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone_number_id: id, from: `+${TO}`, text: "oi" }),
    });
    await send(id, { kind: "text", text: "resposta" });
    const miss = await raw(`/_sim/state?key=${id}:not-a-conversation`);
    const keys = (miss.body as { keys: string[] }).keys;
    expect(keys).toContain(`${id}:+${TO}`);
    expect(keys).toContain(`${id}:${TO}`);

    // With our driver, which strips it, there is one conversation and the window opens.
    const same = pnid();
    await driver.inbound({ phoneNumberId: same, from: `+${TO}`, text: "oi" });
    await send(same, { kind: "text", text: "resposta" });
    const keysAfter = ((await raw(`/_sim/state?key=${same}:not-a-conversation`)).body as { keys: string[] }).keys;
    expect(keysAfter.filter((k) => k.startsWith(`${same}:`))).toEqual([`${same}:${TO}`]);
  });
});
