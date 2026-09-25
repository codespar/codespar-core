/**
 * The house simulator, which is not ours: `dyvit-wa-sim`, the local Cloud API
 * emulator from https://github.com/fabianocruz/whatsapp-simulator (MIT).
 *
 * WHY A SEPARATE PROCESS INSTEAD OF A FAKE IN THIS REPO. A mock we wrote would
 * agree with us by construction — it would accept the payloads we send because
 * we wrote both sides, and the day Meta refused one we would find out in
 * production. The emulator answers `POST /v{version}/{phone-number-id}/messages`
 * with the Cloud API's own response shape and posts back the same signed
 * `x-hub-signature-256` webhooks, so the `simulator` backend is THE SAME CODE
 * as the official one with a different base URL. That is the thing being
 * proved, and it is not something a mock can prove.
 *
 * It also has a clock we can move (`POST /_sim/clock`), which a replay
 * finishing in seconds cannot otherwise have: a collection runs over days, and
 * without moving the clock the 24-hour window never closes, so the one rule
 * that decides whether a message may be sent at all is never exercised.
 *
 * WHAT THIS FILE IS: the `_sim/*` side only — the routes that belong to the
 * emulator and have no counterpart at Meta. The sending and receiving are
 * `WhatsAppCloudApi`, unchanged.
 *
 * The emulator is a separate process and is not a dependency of this workspace:
 * it is a development tool nothing here imports. `scripts/whatsapp-emulator.mjs`
 * fetches `@dyvit/whatsapp-simulator-cli` at a pinned version and runs it;
 * `npm run whatsapp:emulator` is the command.
 */
import type { ConversationScript } from "@codespar/agent-core";
import type { ChannelBackend, InboundMessage, OutboundBody, SentMessage } from "../types.js";
import { toGraphNumber, WhatsAppCloudApi, type CloudApiOptions } from "./cloud-api.js";

export const EMULATOR_ENV = {
  url: "WHATSAPP_SIM_URL",
  appSecret: "WHATSAPP_SIM_APP_SECRET",
  webhookPort: "WHATSAPP_SIM_WEBHOOK_PORT",
  phoneNumberId: "WHATSAPP_SIM_PHONE_NUMBER_ID",
} as const;

export const EMULATOR_DEFAULTS = {
  url: "http://127.0.0.1:4290",
  /** Matches `--app-secret` in `npm run whatsapp:emulator`. A local development value, not a credential. */
  appSecret: "dev",
  webhookPort: 4399,
  phoneNumberId: "900000000001",
  apiVersion: "v22.0",
} as const;

export class EmulatorUnreachableError extends Error {
  constructor(url: string, detail: string) {
    super(
      `the WhatsApp emulator is not answering at ${url} (${detail}).\n` +
        `  Start it in another terminal:  npm run whatsapp:emulator\n` +
        `  It is dyvit-wa-sim, from https://github.com/fabianocruz/whatsapp-simulator — MIT, run from npm at a pinned version, no Meta account and no credential.`,
    );
    this.name = "EmulatorUnreachableError";
  }
}

/** The `_sim/*` routes: what the emulator has and Meta does not. */
export class EmulatorDriver {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw new EmulatorUnreachableError(this.url, err instanceof Error ? err.message : String(err));
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`emulator answered ${response.status} to ${path}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  health(): Promise<unknown> {
    return this.call("/health");
  }

  /** Pins the conversation clock, so a scripted run reads the same at 03:00 as at 15:00. */
  pin(at: Date): Promise<unknown> {
    return this.post("/_sim/clock", { now: at.toISOString() });
  }

  /** Moves the conversation clock forward. The only way to reach the far side of the 24-hour window. */
  advanceHours(hours: number): Promise<unknown> {
    return this.post("/_sim/clock", { advance_hours: hours });
  }

  /** The person writes. The emulator answers with a signed inbound webhook to our receiver. */
  inbound(options: { phoneNumberId: string; from: string; text: string; sentAt?: Date }): Promise<unknown> {
    return this.post("/_sim/inbound", {
      phone_number_id: options.phoneNumberId,
      // Without the `+`, matching what `deliver` sends as `to`: the emulator keys
      // its conversation on the literal string, so the two forms are two people.
      from: toGraphNumber(options.from),
      text: options.text,
      ...(options.sentAt ? { sent_at: options.sentAt.toISOString() } : {}),
    });
  }

  /** The priced timeline, which is the emulator's own reason for existing. Read for the console, never asserted on. */
  state(key: string): Promise<{ priced?: { total?: number; currency?: string } } | undefined> {
    return this.call(`/_sim/state?key=${encodeURIComponent(key)}`).then(
      (v) => v as { priced?: { total?: number; currency?: string } },
      () => undefined,
    );
  }
}

export interface EmulatorBackendOptions extends CloudApiOptions {
  driver: EmulatorDriver;
  /** The person's turns. Absent means they are at the keyboard. */
  script?: ConversationScript | undefined;
  /** The instant the emulator's conversation clock is pinned to. */
  pinAt?: Date | undefined;
  /** Interactive only: reads the person's next line. */
  ask?: ((question: string) => Promise<string>) | undefined;
  /** Where the console draws the conversation as it goes. */
  render: (line: string) => void;
}

/**
 * The `simulator` backend: `WhatsAppCloudApi` pointed at the emulator, plus the
 * one thing the Cloud API has no equivalent for — making the person write.
 *
 * Every outbound message goes through the same `deliver` the Meta backend uses,
 * and every inbound one arrives as a signed webhook at the same receiver, so
 * nothing here is a shortcut around the adapter.
 */
export class WhatsAppEmulator implements ChannelBackend {
  readonly name = "emulator";
  readonly live = false;
  private readonly api: WhatsAppCloudApi;
  private turn = 0;
  private closed = false;

  constructor(private readonly options: EmulatorBackendOptions) {
    const { driver: _driver, script: _script, pinAt: _pinAt, ask: _ask, render: _render, ...api } = options;
    this.api = new WhatsAppCloudApi(api);
  }

  async open(): Promise<void> {
    await this.api.open();
    await this.options.driver.health();
    if (this.options.pinAt) await this.options.driver.pin(this.options.pinAt);
    this.options.render("");
    this.options.render(`  ┌─ WhatsApp (dyvit-wa-sim, emulador local da Cloud API — sem rede externa, sem conta Meta)`);
  }

  async next(): Promise<InboundMessage | undefined> {
    if (this.closed) return undefined;
    const text = await this.nextText();
    if (text === undefined) return undefined;
    // The person writes THROUGH the emulator: it mints the message id and posts
    // the signed webhook our receiver verifies, so a scripted turn takes the
    // same path a real one would.
    await this.options.driver.inbound({
      phoneNumberId: this.options.config.phoneNumberId,
      from: this.options.conversation.contact,
      text,
    });
    return this.api.next();
  }

  private async nextText(): Promise<string | undefined> {
    const script = this.options.script;
    if (script) {
      const turn = script.turns[this.turn];
      if (!turn) return undefined;
      this.turn += 1;
      // The person's own pause, on the emulator's clock. A conversation that
      // happens over days is what closes the 24-hour window.
      if (turn.after_seconds > 0) await this.options.driver.advanceHours(turn.after_seconds / 3600);
      return turn.text;
    }
    if (!this.options.ask) return undefined;
    let answer: string;
    try {
      answer = await this.options.ask("  │ voce> ");
    } catch {
      return undefined;
    }
    const text = answer.trim();
    if (!text) return this.nextText();
    if (["sair", "exit", "quit"].includes(text.toLowerCase())) return undefined;
    return text;
  }

  deliver(to: string, body: OutboundBody): Promise<SentMessage> {
    return this.api.deliver(to, body);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.api.close();
    this.options.render("  └─ fim da conversa");
  }
}
