/**
 * Opening the WhatsApp channel: wiring, and only wiring.
 *
 * It lives apart from the command that starts a conversation because a second
 * command now JOINS one — `codespar-agent poll --channel whatsapp`, which
 * comes back to a conversation the run that opened it has long since ended.
 * Two commands wiring the same channel by hand is how a rule ends up enforced
 * on one path and not the other, and the whole claim of `channels/` is that
 * the rules are above the backend. So both go through here.
 *
 * The decisions are all elsewhere: the rules in `channels/rules.ts`, the
 * session window in `session.ts`, the gates in `terminal.ts`.
 */
import type { ConversationScript, ProofBundle } from "@codespar/agent-core";
import type { Agent } from "../../agent.js";
import type { Setup } from "../../setup.js";
import { knownSubjects, loadTemplates } from "../index.js";
import type { ChannelBackend, Conversation } from "../types.js";
import { WhatsAppChannel } from "./index.js";
import { toGraphNumber, WhatsAppCloudApi, loadCloudApiConfig, type CloudApiConfig } from "./cloud-api.js";
import { EmulatorDriver, EMULATOR_DEFAULTS, EMULATOR_ENV, WhatsAppEmulator } from "./emulator.js";
import type { SessionState } from "./session.js";

export type WhatsAppBackendName = "simulator" | "cloud-api";

export interface OpenWhatsAppOptions {
  agent: Agent;
  setup: Setup;
  conversation: Conversation;
  backend: WhatsAppBackendName;
  now: () => Date;
  say: (line: string) => void;
  /**
   * Where the conversation is recorded. Normally the run's own bundle; a poll
   * hands the bundle of the run it is continuing, because a conversation is
   * one record and the message that closes it belongs with the ones that
   * opened it.
   */
  bundle: ProofBundle;
  /** The person's turns, when a script drives them. Absent and with no `ask`, nobody writes. */
  script?: ConversationScript | undefined;
  /** Interactive only: reads the person's next line. */
  ask?: ((question: string) => Promise<string>) | undefined;
  /**
   * Pins the emulator's CONVERSATION clock. A run that starts a conversation
   * pins it; a run that joins one must not, because rewinding the provider's
   * clock would reopen a window that really is shut. The agent's own notion of
   * now is `now` above and is a different thing (#16).
   */
  pinAt?: Date | undefined;
  /** Where the session window stood when an earlier run left this conversation. */
  session?: SessionState | undefined;
  /** Draws the conversation on the operator's console. */
  render?: ((line: string) => void) | undefined;
}

export interface OpenedWhatsApp {
  channel: WhatsAppChannel;
  /** The `_sim/*` side, when the backend is the emulator. Absent against Meta. */
  driver?: EmulatorDriver;
  /** How the emulator keys this conversation, for the priced timeline. */
  sessionKey?: string;
}

/**
 * Builds the channel, or explains what is missing. Nothing is opened here:
 * the caller opens it, because an emulator that is not running has to be
 * reported differently depending on how far the command already got.
 */
export function buildWhatsApp(options: OpenWhatsAppOptions): OpenedWhatsApp | { refusal: string[] } {
  const { agent, setup: s, say } = options;
  let backend: ChannelBackend;
  let driver: EmulatorDriver | undefined;
  let sessionKey: string | undefined;

  if (options.backend === "cloud-api") {
    const { config, missing } = loadCloudApiConfig(process.env);
    if (!config) {
      return {
        refusal: [
          `the cloud-api backend needs credentials this repo ships none of: ${missing.join(", ")}.`,
          `They live in the agent's .env (commented out in .env.example) and belong to a Meta Business account. The emulator needs none: drop --backend cloud-api.`,
        ],
      };
    }
    say("[whatsapp] cloud-api backend: this repo has never run one against Meta. The shapes are written from the published documentation; the first live run is yours.");
    backend = new WhatsAppCloudApi({ config, conversation: { contact: options.conversation.contact }, say });
  } else {
    // The SAME backend, pointed somewhere else. What the emulator adds is the
    // `_sim/*` side: making the person write, and moving the conversation clock.
    const env = process.env;
    const url = env[EMULATOR_ENV.url]?.trim() || EMULATOR_DEFAULTS.url;
    const config: CloudApiConfig = {
      baseUrl: url,
      phoneNumberId: env[EMULATOR_ENV.phoneNumberId]?.trim() || EMULATOR_DEFAULTS.phoneNumberId,
      // Not credentials: the emulator has no auth, and these are the values
      // `npm run whatsapp:emulator` starts it with.
      accessToken: "emulator",
      verifyToken: "emulator",
      appSecret: env[EMULATOR_ENV.appSecret]?.trim() || EMULATOR_DEFAULTS.appSecret,
      apiVersion: EMULATOR_DEFAULTS.apiVersion,
      webhookPort: Number(env[EMULATOR_ENV.webhookPort]?.trim() || EMULATOR_DEFAULTS.webhookPort),
    };
    driver = new EmulatorDriver(url);
    sessionKey = `${config.phoneNumberId}:${toGraphNumber(options.conversation.contact)}`;
    backend = new WhatsAppEmulator({
      config,
      conversation: { contact: options.conversation.contact },
      driver,
      say,
      render: options.render ?? say,
      ...(options.script ? { script: options.script } : {}),
      ...(options.ask ? { ask: options.ask } : {}),
      ...(options.pinAt ? { pinAt: options.pinAt } : {}),
    });
  }

  // The hours are the agent's, from `guardrails.envelope.collection_hours`. An agent that declares none gets no hours rule, which is correct: not every conversation is a collection.
  const window = typeof s.guardrails.envelope?.["collection_hours"] === "string" ? (s.guardrails.envelope["collection_hours"] as string) : undefined;

  const channel = new WhatsAppChannel({
    backend,
    conversation: options.conversation,
    now: options.now,
    ...(window ? { hours: { window, timezone: s.guardrails.timezone } } : {}),
    knownSubjects: knownSubjects(agent),
    templates: loadTemplates(agent),
    bundle: options.bundle,
    say,
    render: options.render ?? say,
    ...(options.session ? { session: options.session } : {}),
  });

  return { channel, ...(driver ? { driver } : {}), ...(sessionKey ? { sessionKey } : {}) };
}

/** The priced timeline the emulator computed: read for the console, never asserted on. */
export async function simulatedCost(driver: EmulatorDriver | undefined, sessionKey: string | undefined): Promise<{ total: number; currency: string } | undefined> {
  if (!driver || !sessionKey) return undefined;
  const state = (await driver.state(sessionKey).catch(() => undefined)) as { priced?: { total?: number; currency?: string } } | undefined;
  if (typeof state?.priced?.total !== "number") return undefined;
  return { total: state.priced.total, currency: state.priced.currency ?? "BRL" };
}
