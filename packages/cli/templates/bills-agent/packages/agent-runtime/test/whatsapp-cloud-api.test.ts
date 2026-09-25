/**
 * The official backend, without Meta.
 *
 * Nothing here reaches the network. What is driven is the half where a
 * mistake is silent: the signature check (a wrong one that passes is an open
 * webhook), the webhook parse (a shape misread is a message never answered),
 * the verification handshake, and the request builder. The send itself is one
 * `fetch` over a request these functions built, and the one test that touches
 * `deliver` injects a fetch that asserts what it was handed — so a regression
 * that started calling Meta would fail here instead of dialling out.
 *
 * The shapes come from Meta's published documentation. Nobody on this repo
 * has a Business account, so none of this has been run against Meta, and the
 * README says so in those words rather than implying otherwise.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSendRequest,
  isMetaBaseUrl,
  loadCloudApiConfig,
  parseInbound,
  verifyChallenge,
  verifyWebhookSignature,
  WhatsAppCloudApi,
  type CloudApiConfig,
} from "../src/channels/whatsapp/cloud-api.js";

const CONFIG: CloudApiConfig = {
  baseUrl: "https://graph.facebook.com",
  phoneNumberId: "111222333",
  accessToken: "test-token-not-a-credential",
  verifyToken: "verify-me",
  appSecret: "app-secret-for-the-test",
  apiVersion: "v21.0",
  webhookPort: 3111,
};

const sign = (body: string, secret = CONFIG.appSecret) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

describe("credentials are absent by default", () => {
  it("names every variable that is missing rather than saying 'misconfigured'", () => {
    const { config, missing } = loadCloudApiConfig({});
    expect(config).toBeUndefined();
    expect(missing).toEqual(["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]);
  });

  it("treats an empty value as absent: a commented-out .env.example must not half-configure a channel", () => {
    const { config, missing } = loadCloudApiConfig({ WHATSAPP_PHONE_NUMBER_ID: "  ", WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_VERIFY_TOKEN: "v", WHATSAPP_APP_SECRET: "s" });
    expect(config).toBeUndefined();
    expect(missing).toEqual(["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"]);
  });

  it("defaults the version, the port and Meta's own host, and nothing else", () => {
    const { config } = loadCloudApiConfig({ WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_ACCESS_TOKEN: "2", WHATSAPP_VERIFY_TOKEN: "3", WHATSAPP_APP_SECRET: "4" });
    expect(config?.apiVersion).toBe("v21.0");
    expect(config?.webhookPort).toBe(3111);
    expect(config?.baseUrl).toBe("https://graph.facebook.com");
  });
});

describe("live is decided by the base URL, and only by it", () => {
  it("is Meta's host and nothing that merely looks like it", () => {
    expect(isMetaBaseUrl("https://graph.facebook.com")).toBe(true);
    expect(isMetaBaseUrl("https://graph.facebook.com/")).toBe(true);
    expect(isMetaBaseUrl("http://127.0.0.1:4290")).toBe(false);
    expect(isMetaBaseUrl("https://graph.facebook.com.evil.test")).toBe(false);
    expect(isMetaBaseUrl("not a url")).toBe(false);
  });

  it("names itself `emulator` and reports `live: false` off Meta, which is what the evidence builder refuses on", () => {
    const options = { conversation: { contact: "+5511987654321" }, say: () => undefined, fetchImpl: async () => new Response("{}") };
    const emulator = new WhatsAppCloudApi({ ...options, config: { ...CONFIG, baseUrl: "http://127.0.0.1:4290" } });
    expect(emulator.live).toBe(false);
    expect(emulator.name).toBe("emulator");
    const meta = new WhatsAppCloudApi({ ...options, config: CONFIG });
    expect(meta.live).toBe(true);
    expect(meta.name).toBe("cloud-api");
  });

  it("builds the send against whichever base URL it was given, with the path unchanged", () => {
    const request = buildSendRequest({ ...CONFIG, baseUrl: "http://127.0.0.1:4290", apiVersion: "v22.0" }, "+5511987654321", { kind: "text", text: "oi" });
    if ("unsupported" in request) throw new Error("expected a request");
    expect(request.url).toBe("http://127.0.0.1:4290/v22.0/111222333/messages");
  });
});

describe("a delivery is trusted only when it is signed", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account" });

  it("accepts the app secret's own signature over the RAW body", () => {
    expect(verifyWebhookSignature(CONFIG.appSecret, sign(body), body)).toEqual({ ok: true });
  });

  it("refuses a body that was re-serialized: the signature is over bytes", () => {
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyWebhookSignature(CONFIG.appSecret, sign(body), reserialized).ok).toBe(false);
  });

  it("refuses another secret, a missing header and a malformed one", () => {
    expect(verifyWebhookSignature(CONFIG.appSecret, sign(body, "someone-else"), body).ok).toBe(false);
    expect(verifyWebhookSignature(CONFIG.appSecret, undefined, body)).toEqual({ ok: false, reason: "missing X-Hub-Signature-256" });
    expect(verifyWebhookSignature(CONFIG.appSecret, "sha1=abc", body).ok).toBe(false);
    expect(verifyWebhookSignature(CONFIG.appSecret, "nonsense", body).ok).toBe(false);
  });
});

describe("the registration handshake", () => {
  it("echoes the challenge for the right verify token", () => {
    expect(verifyChallenge(CONFIG, { "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" })).toEqual({ status: 200, body: "12345" });
  });

  it("refuses a wrong token and a wrong mode", () => {
    expect(verifyChallenge(CONFIG, { "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }).status).toBe(403);
    expect(verifyChallenge(CONFIG, { "hub.mode": "unsubscribe", "hub.verify_token": "verify-me" }).status).toBe(400);
  });
});

describe("reading what Meta delivers", () => {
  const delivery = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "111222333" },
              messages: [
                { id: "wamid.HBgNNTUxMTk4NzY1NDMyMRUCABIYEjND", from: "5511987654321", timestamp: "1758643200", type: "text", text: { body: "fechado, pago à vista" } },
                { id: "wamid.SECOND", from: "5511987654321", timestamp: "1758643260", type: "image", image: { id: "media_1" } },
              ],
            },
          },
        ],
      },
    ],
  };

  it("reads the text messages and puts the plus back on the number", () => {
    const { messages } = parseInbound(delivery);
    expect(messages).toEqual([{ id: "wamid.HBgNNTUxMTk4NzY1NDMyMRUCABIYEjND", from: "+5511987654321", text: "fechado, pago à vista", timestamp: 1758643200 }]);
  });

  it("names what it dropped instead of turning it into an empty message", () => {
    expect(parseInbound(delivery).ignored).toEqual([{ id: "wamid.SECOND", type: "image" }]);
  });

  it("reads a delivery that carries only status updates as no messages", () => {
    expect(parseInbound({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.X", status: "delivered" }] } }] }] }).messages).toEqual([]);
    expect(parseInbound({}).messages).toEqual([]);
  });
});

describe("the request that would go to Meta", () => {
  it("builds the documented /messages call for a text", () => {
    const request = buildSendRequest(CONFIG, "+5511987654321", { kind: "text", text: "Oi, Joana!" });
    expect("unsupported" in request).toBe(false);
    if ("unsupported" in request) return;
    expect(request.url).toBe("https://graph.facebook.com/v21.0/111222333/messages");
    expect(request.headers["authorization"]).toBe("Bearer test-token-not-a-credential");
    expect(JSON.parse(request.body)).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "5511987654321", type: "text", text: { preview_url: false, body: "Oi, Joana!" } });
  });

  it("sends a copy-and-paste as its own plain text message: a code inside a paragraph cannot be tapped", () => {
    const request = buildSendRequest(CONFIG, "+5511987654321", { kind: "instrument", instrument: "pix_copy_paste", value: "00020126580014br.gov.bcb.pix" });
    if ("unsupported" in request) throw new Error("expected a request");
    expect(JSON.parse(request.body).text.body).toBe("00020126580014br.gov.bcb.pix");
  });

  it("builds a template with its body parameters", () => {
    const request = buildSendRequest(CONFIG, "+5511987654321", { kind: "template", template: "cobranca_lembrete", language: "pt_BR", variables: ["Joana", "1042"] });
    if ("unsupported" in request) throw new Error("expected a request");
    expect(JSON.parse(request.body).template).toEqual({
      name: "cobranca_lembrete",
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Joana" }, { type: "text", text: "1042" }] }],
    });
  });

  it("says outright that it cannot send an image, instead of pretending", () => {
    expect(buildSendRequest(CONFIG, "+5511987654321", { kind: "media", media: "qr", data: "00020126" })).toEqual({ unsupported: "media_upload_unimplemented" });
  });
});

describe("deliver, with the network replaced by an assertion", () => {
  it("posts the request the builder produced and returns the provider's message id", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const backend = new WhatsAppCloudApi({
      config: CONFIG,
      conversation: { contact: "+5511987654321" },
      say: () => undefined,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.SENT" }] }), { status: 200 });
      },
    });
    const sent = await backend.deliver("+5511987654321", { kind: "text", text: "Oi!" });
    expect(sent).toEqual({ id: "wamid.SENT", state: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/111222333/messages");
  });

  it("refuses an image without reaching for the network at all", async () => {
    let called = false;
    const backend = new WhatsAppCloudApi({
      config: CONFIG,
      conversation: { contact: "+5511987654321" },
      say: () => undefined,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });
    const sent = await backend.deliver("+5511987654321", { kind: "media", media: "qr", data: "00020126" });
    expect(sent.refused?.rule).toBe("media_upload_unimplemented");
    expect(called).toBe(false);
  });

  it("reports a provider refusal as a failure and never as a send", async () => {
    const backend = new WhatsAppCloudApi({
      config: CONFIG,
      conversation: { contact: "+5511987654321" },
      say: () => undefined,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }),
    });
    const sent = await backend.deliver("+5511987654321", { kind: "text", text: "Oi!" });
    expect(sent.state).toBe("failed");
    expect(sent.refused?.rule).toBe("provider_refused");
  });
});
