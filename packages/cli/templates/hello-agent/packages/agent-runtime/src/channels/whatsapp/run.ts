/**
 * The conversation loop: the WhatsApp equivalent of `interactive()`, and the
 * same gates in the same order. The person writes, the model answers, the
 * core decides, and what the core produced goes back into the conversation.
 *
 * The one difference from the terminal, and it is the whole reason the
 * channel exists as its own thing: on a terminal the operator and the
 * counterparty are the same pair of eyes, and here they are not. The
 * approval question and the console go to stderr; only `tell` reaches the
 * person. Nothing checks that — it is the wiring: `ask` and `say` are
 * functions this module never hands to the channel.
 *
 * The payable artifact is sent the way a person can actually use it: the QR
 * as an image, and the copy-and-paste as its OWN message underneath, because
 * a code inside a picture cannot be copied and a code inside a paragraph
 * cannot be tapped.
 */
import type { ChargeInstrument, Execution } from "@codespar/agent-core";
import { handleExecution, type TerminalOptions } from "../../terminal.js";
import type { Setup } from "../../setup.js";
import type { OutboundBody } from "../types.js";
import { instrumentBodies } from "./present.js";
import type { WhatsAppChannel } from "./index.js";

export interface ConverseOptions {
  setup: Setup;
  channel: WhatsAppChannel;
  approver: { id: string; channel: string };
  /** The operator's decision when nobody is at a keyboard. The gate runs `mandate`, where there is none to take. */
  decision?: "approve" | "deny" | "none";
  waitSeconds?: number | undefined;
  simulatePayer?: boolean | undefined;
  /** The operator's console. Never the conversation. */
  say: (line: string) => void;
  /** The operator's keyboard, when there is one. Never the conversation. */
  ask?: ((question: string) => Promise<string>) | undefined;
}

export interface ConverseResult {
  turns: number;
  replies: string[];
  toolCalls: Array<{ name: string; refused: boolean }>;
  executions: Execution[];
}

/** Keeps outbound messages in the order the run produced them, across await points. */
class Outbox {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly channel: WhatsAppChannel) {}

  push(body: OutboundBody): void {
    this.chain = this.chain.then(async () => {
      await this.channel.send(body);
    });
  }

  drain(): Promise<void> {
    return this.chain;
  }
}

export async function converse(options: ConverseOptions): Promise<ConverseResult> {
  const { setup: s, channel, approver, say } = options;
  const outbox = new Outbox(channel);
  const replies: string[] = [];
  const toolCalls: Array<{ name: string; refused: boolean }> = [];
  let turns = 0;

  const presentInstrument = (execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument): Promise<void> => {
    for (const body of instrumentBodies(execution, instalment, chargeId, instrument, s.mandate.currency)) outbox.push(body);
    // Awaited by the poll: the person has the code in hand before the next look, not after the cycle closed.
    return outbox.drain();
  };

  const terminalOptions: TerminalOptions = {
    setup: s,
    approver,
    say,
    tell: (line: string) => outbox.push({ kind: "text", text: line }),
    presentInstrument,
    ...(options.decision ? { decision: options.decision } : {}),
    ...(options.ask ? { ask: options.ask } : {}),
    ...(options.waitSeconds !== undefined ? { waitSeconds: options.waitSeconds } : {}),
    ...(options.simulatePayer !== undefined ? { simulatePayer: options.simulatePayer } : {}),
  };

  // The channel is opened by the caller, which is where an emulator that is not
  // running has to be reported: by here the run has already started.
  const runtime = s.makeRuntime();
  const loop = s.makeLoop(runtime, (execution) => handleExecution(execution, terminalOptions));

  say(`${s.manifest.manifest.name} ${s.manifest.manifest.version} — canal: whatsapp (${channel.backend}) — approval: ${s.mode} — trilho: ${s.railKind} — ${s.kit.labels.mandateWord} ${s.mandate.id}`);

  try {
    for (;;) {
      const message = await channel.next();
      if (!message) break;
      turns += 1;
      const result = await loop.turn(message.text);
      toolCalls.push(...result.tool_calls);
      // Whatever the execution put in the conversation goes first: the QR before the sentence that explains it.
      await outbox.drain();
      if (result.reply.trim()) await channel.say(result.reply);
      replies.push(result.reply);
    }
    await outbox.drain();
  } finally {
    await channel.close();
  }

  return { turns, replies, toolCalls, executions: s.engine.list().filter((e) => e.run_id === s.runId) };
}
