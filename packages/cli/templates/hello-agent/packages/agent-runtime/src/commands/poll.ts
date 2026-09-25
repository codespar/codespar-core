/**
 * `codespar-agent poll [--channel terminal|whatsapp] [--wait <seconds>] [--simulate-payer] [--json]`:
 * keeps looking at every receivable still waiting for its payer until it
 * closes or the wait runs out. This is the loop-closer for a run that has no
 * webhook URL; `codespar-agent webhook` is the other. Presents an instrument
 * not yet shown, tells the payer the outcome once, fetches the paid record.
 *
 * `--channel` is on THIS command rather than in a second one, and the reason
 * is that only one thing differs between the two: where the outcome message
 * goes, and which carriers that place allows. The looking, the once-only
 * presentation, the sandbox payer, the receipts and the terminal states are
 * one loop — `pollUntilClosed` — and a second command would have meant a
 * second copy of it, which is exactly how a channel ends up closing a cycle
 * differently from the terminal.
 */
import { stderr, stdout } from "node:process";
import { join } from "node:path";
import { loadManifest, resolveFixedClock, type ChannelName } from "@codespar/agent-core";
import type { Agent } from "../agent.js";
import { setup } from "../setup.js";
import { announceOutcome, waitForPayer } from "../terminal.js";
import { pollWhatsApp } from "./poll-whatsapp.js";
import type { WhatsAppBackendName } from "../channels/whatsapp/open.js";

const USAGE = `codespar-agent poll [options]
  --channel terminal|whatsapp   where the outcome is told. Default terminal.
  --conversation <name>         which channels/whatsapp/<name>.json to come back to (--channel whatsapp)
  --backend simulator|cloud-api default simulator, the local emulator (--channel whatsapp)
  --wait <seconds>              how long to keep looking
  --simulate-payer              let the sandbox payer act once the receivable is payable
  --payer pays|expires|never    what the fixture payer does when it acts (stub rail only)
  --now <ISO 8601>              pin the run's clock; env CODESPAR_AGENT_NOW is the same thing
  --json                        machine output on stdout, everything else on stderr`;

interface Args {
  channel: ChannelName;
  conversation?: string;
  backend?: WhatsAppBackendName;
  wait?: number;
  simulatePayer: boolean;
  payer?: "pays" | "expires" | "never";
  now?: string;
  json: boolean;
}

export function parsePollArgs(argv: string[]): Args {
  const args: Args = { channel: "terminal", simulatePayer: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--json") args.json = true;
    else if (a === "--simulate-payer") args.simulatePayer = true;
    else if (a === "--wait") {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0) throw new Error("--wait must be a number of seconds");
      args.wait = v;
    } else if (a === "--channel") {
      const v = next();
      if (v !== "terminal" && v !== "whatsapp") throw new Error("--channel must be terminal or whatsapp");
      args.channel = v;
    } else if (a === "--backend") {
      const v = next();
      if (v !== "simulator" && v !== "cloud-api") throw new Error("--backend must be simulator or cloud-api");
      args.backend = v;
    } else if (a === "--payer") {
      const v = next();
      if (v !== "pays" && v !== "expires" && v !== "never") throw new Error("--payer must be pays, expires or never");
      args.payer = v;
    } else if (a === "--conversation") args.conversation = next();
    else if (a === "--now") args.now = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (args.channel !== "whatsapp" && (args.backend !== undefined || args.conversation !== undefined)) {
    throw new Error("--backend and --conversation belong to --channel whatsapp");
  }
  return args;
}

export async function poll(agent: Agent, argv: string[]): Promise<number> {
  const say = (l: string) => stderr.write(l + "\n");
  let args: Args;
  let now: (() => Date) | undefined;
  try {
    args = parsePollArgs(argv);
    now = resolveFixedClock(args.now, process.env);
  } catch (err) {
    say(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  if (args.channel === "whatsapp" && !loadManifest(join(agent.dir, "agent.yaml")).manifest.channels.includes("whatsapp")) {
    say(`${agent.slug} does not declare the whatsapp channel in agent.yaml`);
    return 2;
  }

  const s = setup(agent, { say, runId: `run_poll_${Date.now().toString(36)}`, ...(now ? { now } : {}) });
  // The same flag `start` has, and it means more here: a receivable nobody
  // paid reaches its due date BETWEEN two runs, never inside one, so "what
  // happens when it expires" is a question only a poll can be asked.
  if (args.payer) s.payer?.behave(args.payer);
  try {
    if (args.channel === "whatsapp") {
      return await pollWhatsApp({
        agent,
        setup: s,
        conversation: args.conversation,
        backend: args.backend ?? "simulator",
        json: args.json,
        waitSeconds: args.wait,
        simulatePayer: args.simulatePayer,
        ...(args.payer ? { payer: args.payer } : {}),
        now: now ?? (() => new Date()),
        say,
      });
    }
    // `behave` only changes the default for receivables the rail has not
    // looked at, and by now it has looked at these; `decideFor` is what
    // rewrites the fate of one that already exists.
    if (args.payer) {
      for (const open of s.engine.list({ state: "executing" })) {
        for (const outcome of open.outcomes) if (outcome.status === "accepted") s.payer?.decideFor?.(outcome.attempt_id, args.payer);
      }
    }
    const tell = (l: string) => void (args.json ? stderr : stdout).write(l + "\n");
    const results = [];
    for (const open of s.engine.list({ state: "executing" })) {
      if (open.reason !== "awaiting_settlement") continue;
      const r = await waitForPayer(open.id, { setup: s, approver: { id: s.kit.labels.defaultUser, channel: "terminal" }, say, tell, waitSeconds: args.wait, simulatePayer: args.simulatePayer });
      announceOutcome(r.execution, s, tell);
      if (r.execution.state !== "executing") await s.engine.collectReceipts(r.execution.id);
      results.push({ id: r.execution.id, state: r.execution.state, reason: r.execution.reason ?? null, rounds: r.rounds, seconds: r.seconds, timed_out: r.timed_out });
      say(`${r.execution.id}: ${r.execution.state}${r.execution.reason ? ` (${r.execution.reason})` : ""} after ${r.rounds} look(s), ${r.seconds}s`);
    }
    if (args.json) stdout.write(JSON.stringify({ polled: results }) + "\n");
    else if (!results.length) say("nothing waiting for a payer");
    return results.some((r) => r.timed_out) ? 3 : 0;
  } finally {
    s.close();
  }
}
