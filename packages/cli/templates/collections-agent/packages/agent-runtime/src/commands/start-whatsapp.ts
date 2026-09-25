/**
 * `codespar-agent start --channel whatsapp`: wiring, and only wiring.
 *
 * It picks a backend, binds the conversation, hands the channel the rules the
 * agent's own guardrails declare, and runs the loop — all of that through
 * `channels/whatsapp/open.ts`, which `poll --channel whatsapp` goes through
 * too, so the two commands cannot end up enforcing different rules. The
 * decisions are elsewhere: the rules in `channels/rules.ts`, the session
 * window in `channels/whatsapp/session.ts`, the gates in `terminal.ts`, which
 * this path reuses unchanged so the two channels cannot drift on what may
 * execute.
 */
import { stdout } from "node:process";
import { relative } from "node:path";
import type { ConversationScript } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import type { Setup } from "../setup.js";
import { defaultAsk } from "../terminal.js";
import { converse } from "../channels/whatsapp/run.js";
import { buildWhatsApp, simulatedCost, type WhatsAppBackendName } from "../channels/whatsapp/open.js";
import { EmulatorUnreachableError } from "../channels/whatsapp/emulator.js";

export type { WhatsAppBackendName };

export interface StartWhatsAppOptions {
  agent: Agent;
  setup: Setup;
  script: ConversationScript;
  backend: WhatsAppBackendName;
  /** Replay the conversation's turns; otherwise the person is at the keyboard. */
  scripted: boolean;
  approver: { id: string; channel: string };
  json: boolean;
  startedAt: number;
  say: (line: string) => void;
  decision?: "approve" | "deny" | "none";
  waitSeconds?: number | undefined;
  simulatePayer?: boolean | undefined;
  now?: (() => Date) | undefined;
}

export async function startWhatsApp(options: StartWhatsAppOptions): Promise<number> {
  const { agent, setup: s, script, say } = options;
  const now = options.now ?? (() => new Date());
  const conversation = { contact: script.contact, subject: script.subject };

  // A scripted conversation has nobody at a keyboard, and in `human` mode
  // somebody has to decide. Refused rather than left waiting on a stdin that
  // will never answer: a gate that hangs teaches nothing.
  if (options.scripted && s.mode === "human" && !options.decision) {
    say("--scripted has nobody at the keyboard and approval: human needs a decision: add --approve or --deny, or run --mode mandate");
    return 2;
  }

  const built = buildWhatsApp({
    agent,
    setup: s,
    conversation,
    backend: options.backend,
    now,
    say,
    bundle: s.bundle,
    ...(options.scripted ? { script } : { ask: defaultAsk }),
    // A run that STARTS a conversation pins the emulator's clock to its own instant.
    ...(options.now ? { pinAt: options.now() } : {}),
  });
  if ("refusal" in built) {
    for (const line of built.refusal) say(line);
    return 1;
  }
  const { channel, driver, sessionKey } = built;

  // The channel is opened here, which is where an emulator that is not
  // running has to be reported: after this the run has already started.
  try {
    await channel.open();
  } catch (err) {
    if (err instanceof EmulatorUnreachableError) {
      say(err.message);
      return 1;
    }
    throw err;
  }

  const result = await converse({
    setup: s,
    channel,
    approver: options.approver,
    say,
    ...(options.decision ? { decision: options.decision } : {}),
    ...(options.scripted ? {} : { ask: defaultAsk }),
    ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}),
    ...(options.simulatePayer !== undefined ? { simulatePayer: options.simulatePayer } : {}),
  });

  // What the emulator is actually for, and the one number this repo cannot
  // compute: what the conversation would have cost under Meta's rules. Read for
  // the console only — never asserted on, because it is their engine's answer
  // and not a contract of ours.
  const cost = await simulatedCost(driver, sessionKey);

  const log = channel.log();
  const refused = log.filter((l) => l.refused).map((l) => ({ rule: l.refused!.rule, detail: l.refused!.detail }));
  const channelSummary = {
    name: "whatsapp",
    backend: channel.backend,
    conversation: script.name,
    turns: result.turns,
    messages_in: log.filter((l) => l.direction === "in").length,
    messages_out: log.filter((l) => l.direction === "out" && !l.refused).length,
    refused,
    log: relative(process.cwd(), `${s.bundle.dir}/channel.jsonl`),
    ...(cost ? { simulated_cost: cost } : {}),
  };

  if (options.json) {
    const payload = s.kit.oneShotPayload({
      setup: s,
      reply: result.replies[result.replies.length - 1] ?? "",
      toolCalls: result.toolCalls,
      executions: result.executions,
      startedAt: options.startedAt,
    });
    stdout.write(JSON.stringify({ ...payload, channel: channelSummary }) + "\n");
  } else {
    say(`conversa em ${channelSummary.log} — ${channelSummary.messages_in} recebida(s), ${channelSummary.messages_out} enviada(s)${refused.length ? `, ${refused.length} recusada(s)` : ""}`);
    if (cost) say(`custo simulado desta conversa nas regras da Meta: ${cost.total.toFixed(4)} ${cost.currency} (conta do emulador, nao nossa)`);
  }

  return result.executions.some((e) => e.state === "executing") ? 3 : 0;
}
