/**
 * The official backend: Meta's WhatsApp Cloud API, behind the same interface
 * the simulator implements. An ADAPTER and nothing more — the rules, the
 * session window and the conversation record are the channel's, above this.
 *
 * Three things about it are deliberate.
 *
 * The credentials are ABSENT by default and this backend refuses to open
 * without them, by name. No fallback, no "development mode" that quietly
 * talks to nobody: a channel that pretends to send is worse than one that
 * says it cannot.
 *
 * Nothing here is called from a test or from the CI, ever. What the tests
 * exercise are the four pure functions — the signature check, the webhook
 * parse, the verification handshake and the request builder — which is
 * exactly the part where a mistake is silent. The send itself is one `fetch`
 * over a request those functions built.
 *
 * And the shapes are written against Meta's published documentation, not
 * against a call we made: nobody on this repo has a Business account, so the
 * first live run belongs to the developer who has one. The README says that
 * in those words, and `docs/OPEN_QUESTIONS.md` names what a live run would
 * settle.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { ChannelBackend, DeliveryState, InboundMessage, InboundReply, OutboundBody, SentMessage, StatusUpdate } from "../types.js";

export interface CloudApiConfig {
  /**
   * Where the Graph API lives. Meta's own by default, and the local emulator's
   * when the run is against the local emulator — which is the whole point of
   * having it be a field: the two backends are THE SAME CODE with a different
   * base URL, so the simulator exercises the adapter instead of standing in
   * for it. A mock of our own would only ever agree with us.
   */
  baseUrl: string;
  /** The number the business sends from, as Meta's dashboard names it. */
  phoneNumberId: string;
  accessToken: string;
  /** Echoed back on the `GET` handshake when Meta registers the webhook. */
  verifyToken: string;
  /** The app secret that signs deliveries. Without it no delivery is trusted. */
  appSecret: string;
  apiVersion: string;
  webhookPort: number;
}

/** Meta's own Graph host. Anything else is a stand-in, and the channel treats it as one. */
export const META_GRAPH_HOST = "graph.facebook.com";

/**
 * Whether this base URL is Meta. It decides one thing that matters beyond
 * logging: `live`, which is what the consent-evidence builder refuses on. An
 * act observed by an emulator was observed by nobody.
 */
export function isMetaBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === META_GRAPH_HOST;
  } catch {
    return false;
  }
}

export const CLOUD_API_ENV = {
  phoneNumberId: "WHATSAPP_PHONE_NUMBER_ID",
  accessToken: "WHATSAPP_ACCESS_TOKEN",
  verifyToken: "WHATSAPP_VERIFY_TOKEN",
  appSecret: "WHATSAPP_APP_SECRET",
  apiVersion: "WHATSAPP_API_VERSION",
  webhookPort: "WHATSAPP_WEBHOOK_PORT",
  baseUrl: "WHATSAPP_GRAPH_URL",
} as const;

export interface ConfigResult {
  config?: CloudApiConfig;
  /** The variables that are not set. A refusal names them rather than saying "misconfigured". */
  missing: string[];
}

export function loadCloudApiConfig(env: NodeJS.ProcessEnv): ConfigResult {
  const read = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const phoneNumberId = read(CLOUD_API_ENV.phoneNumberId);
  const accessToken = read(CLOUD_API_ENV.accessToken);
  const verifyToken = read(CLOUD_API_ENV.verifyToken);
  const appSecret = read(CLOUD_API_ENV.appSecret);
  const missing = [
    ...(phoneNumberId ? [] : [CLOUD_API_ENV.phoneNumberId]),
    ...(accessToken ? [] : [CLOUD_API_ENV.accessToken]),
    ...(verifyToken ? [] : [CLOUD_API_ENV.verifyToken]),
    ...(appSecret ? [] : [CLOUD_API_ENV.appSecret]),
  ];
  if (!phoneNumberId || !accessToken || !verifyToken || !appSecret) return { missing };
  return {
    missing,
    config: {
      baseUrl: read(CLOUD_API_ENV.baseUrl) ?? `https://${META_GRAPH_HOST}`,
      phoneNumberId,
      accessToken,
      verifyToken,
      appSecret,
      apiVersion: read(CLOUD_API_ENV.apiVersion) ?? "v21.0",
      webhookPort: Number(read(CLOUD_API_ENV.webhookPort) ?? 3111),
    },
  };
}

/* ── the pure half: what the tests drive ─────────────────────── */

/**
 * `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 of the RAW body under the
 * app secret. Raw and not re-serialized: a body that round-tripped through
 * `JSON.parse` is a different string, and the signature is over bytes.
 */
export function verifyWebhookSignature(appSecret: string, header: string | undefined, rawBody: string): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing X-Hub-Signature-256" };
  const [algorithm, signature] = header.split("=");
  if (algorithm !== "sha256" || !signature) return { ok: false, reason: "malformed signature header" };
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  if (expected.length !== signature.length) return { ok: false, reason: "signature mismatch" };
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return { ok: false, reason: "signature mismatch" };
  return { ok: true };
}

/** The `GET` handshake Meta makes once, when the webhook URL is registered. */
export function verifyChallenge(config: CloudApiConfig, query: Record<string, string | undefined>): { status: number; body: string } {
  if (query["hub.mode"] !== "subscribe") return { status: 400, body: "bad mode" };
  if (query["hub.verify_token"] !== config.verifyToken) return { status: 403, body: "bad verify token" };
  return { status: 200, body: query["hub.challenge"] ?? "" };
}

interface CloudApiEnvelope {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          interactive?: { type?: string; button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } };
          button?: { payload?: string; text?: string };
          context?: { id?: string };
        }>;
        statuses?: Array<{ id?: string; status?: string; timestamp?: string; errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }> }>;
      };
    }>;
  }>;
}

/**
 * What one delivery carries. A delivery holds several entries, each with
 * several changes, each with messages and with STATUS updates about messages
 * we sent. A message is read when it is text, or a tapped quick reply (an
 * interactive `button_reply` / `list_reply`, or a template's `button`), which
 * keeps its id — the channel decides whether that id means anything. Anything
 * else (an image, a location) is dropped with its id named: this channel
 * reads words and taps, and an unreadable message must not become an empty
 * turn.
 */
export function parseInbound(payload: unknown): { messages: InboundMessage[]; statuses: StatusUpdate[]; ignored: Array<{ id: string; type: string }> } {
  const envelope = payload as CloudApiEnvelope;
  const messages: InboundMessage[] = [];
  const statuses: StatusUpdate[] = [];
  const ignored: Array<{ id: string; type: string }> = [];
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        const id = message.id;
        const from = message.from;
        if (!id || !from) continue;
        const base = { id, from: from.startsWith("+") ? from : `+${from}`, timestamp: Number(message.timestamp ?? 0) };
        const reply = replyOf(message);
        if (reply) {
          messages.push({ ...base, text: reply.title, reply: { ...reply, ...(message.context?.id ? { context_id: message.context.id } : {}) } });
          continue;
        }
        if (message.type !== "text" || !message.text?.body) {
          ignored.push({ id, type: message.type === "interactive" ? `interactive:${message.interactive?.type ?? "unknown"}` : message.type ?? "unknown" });
          continue;
        }
        messages.push({ ...base, text: message.text.body });
      }
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !isDeliveryState(status.status)) continue;
        statuses.push({
          message_id: status.id,
          status: status.status,
          timestamp: Number(status.timestamp ?? 0),
          errors: (status.errors ?? []).map((e) => ({
            ...(typeof e.code === "number" ? { code: e.code } : {}),
            ...(e.title ?? e.message ? { title: e.title ?? e.message } : {}),
            ...(e.error_data?.details ? { details: e.error_data.details } : {}),
          })),
        });
      }
    }
  }
  return { messages, statuses, ignored };
}

type CloudMessage = NonNullable<NonNullable<NonNullable<NonNullable<CloudApiEnvelope["entry"]>[number]["changes"]>[number]["value"]>["messages"]>[number];

function replyOf(message: CloudMessage): Omit<InboundReply, "context_id"> | undefined {
  if (message.type === "interactive") {
    const kind = message.interactive?.type;
    const picked = kind === "button_reply" ? message.interactive?.button_reply : kind === "list_reply" ? message.interactive?.list_reply : undefined;
    if ((kind === "button_reply" || kind === "list_reply") && picked?.id) return { type: kind, id: picked.id, title: picked.title ?? picked.id };
    return undefined;
  }
  if (message.type === "button" && message.button?.payload) return { type: "button", id: message.button.payload, title: message.button.text ?? message.button.payload };
  return undefined;
}

function isDeliveryState(value: unknown): value is DeliveryState {
  return value === "sent" || value === "delivered" || value === "read" || value === "failed";
}

export interface SendRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * The `/messages` call, as Meta documents it. `to` loses its `+`: the Cloud
 * API wants the number in international format without the plus.
 *
 * `media` has no branch here and that is the honest answer, not an omission.
 * Sending an image means uploading it first (`POST /{version}/{phone-number-id}/media`,
 * multipart) or handing Meta a public URL, and this repo hosts nothing and
 * renders no PNG — `qrcode-terminal` draws characters. The channel therefore
 * sends the copy-and-paste as its own message, which is the string that
 * actually pays, and the QR is the simulator's. Named in the README and in
 * `docs/OPEN_QUESTIONS.md`.
 */
export function buildSendRequest(config: CloudApiConfig, to: string, body: OutboundBody): SendRequest | { unsupported: string } {
  const base = {
    url: `${config.baseUrl.replace(/\/$/, "")}/${config.apiVersion}/${config.phoneNumberId}/messages`,
    method: "POST" as const,
    headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
  };
  const recipient = { messaging_product: "whatsapp", recipient_type: "individual", to: toGraphNumber(to) };
  switch (body.kind) {
    case "text":
      return { ...base, body: JSON.stringify({ ...recipient, type: "text", text: { preview_url: false, body: body.text } }) };
    case "instrument":
      return { ...base, body: JSON.stringify({ ...recipient, type: "text", text: { preview_url: false, body: body.value } }) };
    case "template":
      return {
        ...base,
        body: JSON.stringify({
          ...recipient,
          type: "template",
          template: {
            name: body.template,
            language: { code: body.language },
            ...templateComponents(body),
          },
        }),
      };
    case "media":
      return { unsupported: "media_upload_unimplemented" };
  }
}

/**
 * A template's parameters as Meta takes them: the body's variables, and one
 * `quick_reply` button component per declared reply, whose `payload` is the
 * reply id — what comes back as `button.payload` when the person taps it.
 */
function templateComponents(body: Extract<OutboundBody, { kind: "template" }>): { components?: unknown[] } {
  const components: unknown[] = [];
  if (body.variables.length) components.push({ type: "body", parameters: body.variables.map((text) => ({ type: "text", text })) });
  for (const [index, button] of (body.buttons ?? []).entries()) components.push({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload: button.id }] });
  return components.length ? { components } : {};
}

/** Meta's error for a free-form message outside the 24 hours after the person's last one. */
export const WINDOW_CLOSED_ERROR = 131047;

/**
 * What a non-2xx from `/messages` means, read from Meta's error body.
 *
 * One code gets its own rule: 131047 is the provider saying the 24-hour
 * window is shut, which is the SAME rule the channel enforces before a send
 * and is answered the same way — with a template. It reaches here only when
 * the two clocks disagree (ours read the window open, the provider's read it
 * shut), which at the boundary is a race and not a bug, so a caller has to be
 * able to tell it from a refusal it cannot do anything about.
 */
export function providerRefusal(status: number, body: string): { rule: string; detail: string } {
  let error: { code?: unknown; message?: unknown; error_data?: { details?: unknown } } | undefined;
  try {
    error = (JSON.parse(body) as { error?: typeof error }).error;
  } catch {
    /* an error without Meta's envelope: the status is all there is */
  }
  const details = typeof error?.error_data?.details === "string" ? error.error_data.details : undefined;
  if (error?.code === WINDOW_CLOSED_ERROR) {
    return {
      rule: "session_window_closed",
      detail: `the provider refused the free-form message (${status}/${WINDOW_CLOSED_ERROR}): its 24h window is shut${details ? ` — ${details}` : ""}`,
    };
  }
  const code = typeof error?.code === "number" ? `/${error.code}` : "";
  return { rule: "provider_refused", detail: `${status}${code} from the Cloud API${details ? ` — ${details}` : ""}` };
}

/* ── the impure half: one fetch over a request the above built ── */

/** `+5511987654321` -> `5511987654321`, the only form the Graph API takes. */
export function toGraphNumber(contact: string): string {
  return contact.replace(/^\+/, "");
}

export interface CloudApiOptions {
  config: CloudApiConfig;
  conversation: { contact: string };
  say: (line: string) => void;
  /** Injected so a test can drive `deliver` without a network. The default is the platform's. */
  fetchImpl?: typeof fetch;
}

export class WhatsAppCloudApi implements ChannelBackend {
  readonly name: string;
  /** True only against Meta. The emulator is a stand-in and says so. */
  readonly live: boolean;
  private server: Server | undefined;
  private readonly queue: InboundMessage[] = [];
  /** Message ids already handed on. Meta delivers at-least-once, so the same message can arrive twice. */
  private readonly seen = new Set<string>();
  private waiting: ((m: InboundMessage | undefined) => void) | undefined;
  private statusListener: ((status: StatusUpdate) => void) | undefined;
  private closed = false;

  constructor(private readonly options: CloudApiOptions) {
    this.live = isMetaBaseUrl(options.config.baseUrl);
    this.name = this.live ? "cloud-api" : "emulator";
  }

  /** The port the receiver is listening on, which the emulator has to be told about. */
  get webhookPort(): number {
    return this.options.config.webhookPort;
  }

  async open(): Promise<void> {
    const { config, say } = this.options;
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.webhookPort}`);
      if (req.method === "GET") {
        const query = Object.fromEntries(url.searchParams.entries());
        const answer = verifyChallenge(config, query);
        res.writeHead(answer.status, { "content-type": "text/plain" }).end(answer.body);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const header = req.headers["x-hub-signature-256"];
        const check = verifyWebhookSignature(config.appSecret, Array.isArray(header) ? header[0] : header, raw);
        if (!check.ok) {
          say(`[whatsapp] delivery refused: ${check.reason}`);
          res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad_signature" }));
          return;
        }
        let parsed: ReturnType<typeof parseInbound>;
        try {
          parsed = parseInbound(JSON.parse(raw));
        } catch {
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
        for (const ignored of parsed.ignored) say(`[whatsapp] ignored ${ignored.type} message ${ignored.id}: this channel reads text and taps`);
        for (const message of parsed.messages) this.push(message);
        for (const status of parsed.statuses) this.statusListener?.(status);
        // Always 200 once read: Meta retries on anything else, and a duplicate is not an error.
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: parsed.messages.length }));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(config.webhookPort, resolve));
    say(
      this.live
        ? `[whatsapp] cloud API backend: webhook on http://127.0.0.1:${config.webhookPort}/ — expose it and register it with Meta; deliveries are verified against ${CLOUD_API_ENV.appSecret}`
        : `[whatsapp] emulator backend: sending to ${config.baseUrl}/${config.apiVersion}, receiving signed deliveries on http://127.0.0.1:${config.webhookPort}/`,
    );
  }

  private push(message: InboundMessage): void {
    // A redelivery is the same message, not a second turn: answering it twice
    // would put two replies in front of the person for one thing they said.
    if (this.seen.has(message.id)) {
      this.options.say(`[whatsapp] duplicate delivery of ${message.id} dropped`);
      return;
    }
    this.seen.add(message.id);
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(message);
      return;
    }
    this.queue.push(message);
  }

  onStatus(listener: (status: StatusUpdate) => void): void {
    this.statusListener = listener;
  }

  async next(): Promise<InboundMessage | undefined> {
    if (this.closed) return undefined;
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<InboundMessage | undefined>((resolve) => {
      this.waiting = resolve;
    });
  }

  async deliver(to: string, body: OutboundBody): Promise<SentMessage> {
    const request = buildSendRequest(this.options.config, to, body);
    if ("unsupported" in request) {
      return { id: "", state: "failed", refused: { rule: request.unsupported, detail: "this backend cannot upload media: the copy-and-paste text is what pays, and the QR image is the simulator's" } };
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    const text = await response.text();
    if (!response.ok) return { id: "", state: "failed", refused: providerRefusal(response.status, text) };
    let id = "";
    try {
      id = String((JSON.parse(text) as { messages?: Array<{ id?: string }> }).messages?.[0]?.id ?? "");
    } catch {
      /* a 2xx with an unreadable body: the message went, the id did not come back */
    }
    return { id, state: "sent" };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.waiting) {
      this.waiting(undefined);
      this.waiting = undefined;
    }
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
