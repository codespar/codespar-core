/**
 * The case the channel could not run before: agreed on Tuesday, paid on
 * Friday.
 *
 * Every case that converses runs TWO processes over ONE state directory,
 * because that is the shape in production — the run that agreed the terms has
 * exited by the time the money lands, and what carries the cycle across is
 * the record it left. Between them the CONVERSATION's clock moves
 * (`POST /_sim/clock`), which is a different thing from the AGENT's clock
 * (`--now`, #16): one is where the person's last message sits, the other is
 * what the guardrails and the window comparison read.
 *
 * What is asserted is which CARRIER the confirmation went out on and that the
 * cycle closed, never the wording. Read the template assertions precisely:
 * the emulator prices the 24-hour window and does not enforce it
 * (docs/OPEN_QUESTIONS.md §46a), so what passes here is OUR choice of
 * carrier, made by the session window, and not the provider refusing the
 * alternative.
 *
 * The conversing cases SKIP without the emulator, like the rest of the
 * channel suite; `npm run whatsapp:gate` fails rather than skipping, so the
 * thing that matters never hides behind one. The cases that need no
 * conversation at all — the no-op, the flag that belongs to another channel —
 * run everywhere.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";

/** Tuesday, inside the collection hours the guardrails declare. */
const TUESDAY = "2026-09-23T14:00:00-03:00";
const ADVANCE_HOURS = 26;
/** The same instant plus the advance: 16:00 in Sao Paulo, still inside 08:00-20:00. */
const AFTER_WINDOW = new Date(new Date(TUESDAY).getTime() + ADVANCE_HOURS * 3600_000).toISOString();
/**
 * The recording where the charge is issued and NOBODY has paid yet. The
 * shipped happy-path one closes with "quitado" because its payer paid inside
 * the turn; here that would be a lie, and it is the lie this whole command
 * exists to stop telling.
 */
const AGREED = "test/fixtures/agreed-1042-awaiting-payer.transcript.jsonl";

interface ChannelLine {
  direction: "in" | "out";
  kind: string;
  text?: string;
  message_id: string;
  provider_timestamp?: number;
  refused?: { rule: string };
}

interface Polled {
  id: string;
  state: string;
  reason: string | null;
  timed_out: boolean;
  session_open: boolean;
  delivery: { told: boolean; carrier?: string; template?: string; reason?: string };
}

interface PollPayload {
  polled: Polled[];
  conversation: string;
  channel: { backend: string; session_open: boolean; messages_out: number; refused: Array<{ rule: string }>; log: string } | null;
}

function scratch(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `collections-wa-poll-${label}-`));
  return { COLLECTIONS_STATE_DIR: stateDir, COLLECTIONS_RUNS_DIR: join(stateDir, "runs") };
}

function agent(args: string[], env: Record<string, string>) {
  const result = spawnSync(NODE, [BIN, ...args], {
    cwd: AGENT_DIR,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      CODESPAR_API_KEY: "",
      // A developer's own Meta credentials must not change what this suite does.
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_VERIFY_TOKEN: "",
      WHATSAPP_APP_SECRET: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Tuesday: the debtor agrees, the bolepix is issued, and the fixture payer is told to sit on it. */
function agree(env: Record<string, string>) {
  return agent(
    ["start", "--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--mode", "mandate", "--transcript", AGREED, "--now", TUESDAY, "--json"],
    { ...env, COLLECTIONS_STUB_PAYER: "never" },
  );
}

function poll(env: Record<string, string>, extra: string[] = []) {
  const out = agent(["poll", "--channel", "whatsapp", "--conversation", "acordo-1042", "--json", ...extra], env);
  const lines = out.stdout.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return { ...out, payload: JSON.parse(lines[0]!) as PollPayload };
}

async function advanceConversationClock(hours: number) {
  const response = await fetch(`${EMULATOR}/_sim/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ advance_hours: hours }),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
}

function conversationOf(logPath: string): ChannelLine[] {
  const path = isAbsolute(logPath) ? logPath : join(AGENT_DIR, logPath);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChannelLine);
}

function countEvents(env: Record<string, string>, type: string): number {
  const db = new DatabaseSync(join(env["COLLECTIONS_STATE_DIR"]!, "state.db"));
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = ?").get(type) as { n: number }).n;
  } finally {
    db.close();
  }
}

const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!emulatorUp) process.stderr.write(`[whatsapp] no emulator at ${EMULATOR}; the poll's conversing cases are skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

describe.skipIf(!emulatorUp)("a charge paid after the 24-hour window closed", () => {
  it("confirms by template, closes the cycle, and leaves one conversation rather than two", async () => {
    const env = scratch("template");

    const agreed = agree(env);
    // Nobody has paid: the execution is still open and that is why the process exits 3.
    expect(agreed.code).toBe(3);
    const opened = JSON.parse(agreed.stdout.split("\n").filter(Boolean).pop()!) as { executions: Array<{ state: string; reason: string }>; channel: { log: string } };
    expect(opened.executions[0]).toMatchObject({ state: "executing", reason: "awaiting_settlement" });
    const before = conversationOf(opened.channel.log);
    // The person's own message carries the provider's clock, which is the only
    // thing the window can be counted from once this process is gone.
    expect(before.filter((l) => l.direction === "in").every((l) => typeof l.provider_timestamp === "number")).toBe(true);
    expect(before.some((l) => l.direction === "out" && /quitad/i.test(l.text ?? ""))).toBe(false);

    await advanceConversationClock(ADVANCE_HOURS);

    const polled = poll(env, ["--simulate-payer", "--now", AFTER_WINDOW]);
    expect(polled.code).toBe(0);
    expect(polled.payload.polled).toHaveLength(1);
    expect(polled.payload.polled[0]).toMatchObject({
      state: "settled",
      timed_out: false,
      session_open: false,
      delivery: { told: true, carrier: "template", template: "acordo_quitado" },
    });
    expect(polled.payload.channel?.refused).toEqual([]);
    // One message, and only one, went out with the window shut.
    expect(polled.payload.channel?.messages_out).toBe(1);

    // The confirmation was appended to the bundle of the run that opened the
    // conversation, so it sits under the QR it confirms instead of in a second folder.
    const after = conversationOf(polled.payload.channel!.log);
    expect(after.slice(0, before.length)).toEqual(before);
    const last = after[after.length - 1]!;
    expect(last.kind).toBe("template");
    expect(last.text).toContain("acordo_quitado");
    expect(last.refused).toBeUndefined();
    // It went through the provider's own surface, not around it.
    expect(last.message_id).toMatch(/^wamid\./);

    expect(countEvents(env, "message.debtor")).toBe(1);
    expect(countEvents(env, "commerce.charge.paid")).toBe(1);
    const runs = env["COLLECTIONS_RUNS_DIR"]!;
    const receipts = readdirSync(runs).flatMap((d) => (existsSync(join(runs, d, "receipts")) ? readdirSync(join(runs, d, "receipts")) : []));
    expect(receipts).toHaveLength(1);
  });

  it("polled twice, tells the person once: the cursor that says so is in state.db, not in the process", async () => {
    const env = scratch("twice");
    expect(agree(env).code).toBe(3);
    await advanceConversationClock(ADVANCE_HOURS);

    const first = poll(env, ["--simulate-payer", "--now", AFTER_WINDOW]);
    expect(first.payload.polled[0]!.delivery.told).toBe(true);

    // The execution is terminal, so there is nothing left waiting for a payer
    // and the second poll never opens the channel at all.
    const second = poll(env, ["--simulate-payer", "--now", AFTER_WINDOW]);
    expect(second.code).toBe(0);
    expect(second.payload.polled).toEqual([]);
    expect(second.payload.channel).toBeNull();
    expect(countEvents(env, "message.debtor")).toBe(1);
  });

  it("writes freely while the window is still open: the carrier follows the rule, not the command", async () => {
    const env = scratch("open");
    expect(agree(env).code).toBe(3);
    // No clock move: the person wrote minutes ago.
    const polled = poll(env, ["--simulate-payer", "--now", "2026-09-23T15:30:00-03:00"]);
    expect(polled.code).toBe(0);
    expect(polled.payload.polled[0]).toMatchObject({ state: "settled", session_open: true, delivery: { told: true, carrier: "text" } });
    const last = conversationOf(polled.payload.channel!.log).at(-1)!;
    expect(last.kind).toBe("text");
    expect(last.text).toMatch(/quitad/i);
  });

  it("a charge that expired gets the expiry template and not the paid one", async () => {
    const env = scratch("expired");
    expect(agree(env).code).toBe(3);
    await advanceConversationClock(ADVANCE_HOURS);

    // No `--simulate-payer`: nobody paid, and that is the point. `--payer
    // expires` rewrites the fate of the receivable this state already holds.
    const polled = poll(env, ["--payer", "expires", "--now", AFTER_WINDOW]);
    expect(polled.payload.polled[0]).toMatchObject({
      state: "failed",
      reason: "charge_expired",
      session_open: false,
      delivery: { told: true, carrier: "template", template: "acordo_cobranca_vencida" },
    });
    const last = conversationOf(polled.payload.channel!.log).at(-1)!;
    expect(last.text).toContain("acordo_cobranca_vencida");
    expect(last.text).not.toContain("acordo_quitado");
    // Nothing was paid, so nothing was sealed.
    const runs = env["COLLECTIONS_RUNS_DIR"]!;
    expect(readdirSync(runs).flatMap((d) => (existsSync(join(runs, d, "receipts")) ? readdirSync(join(runs, d, "receipts")) : []))).toHaveLength(0);
  });
});

describe("what the poll refuses to be asked, with no emulator in sight", () => {
  it("nothing waiting for a payer is a clean no-op, not an error: a cron that fails on an empty queue gets turned off", () => {
    const env = scratch("noop");
    const out = poll(env, ["--now", TUESDAY]);
    expect(out.code).toBe(0);
    expect(out.payload).toEqual({ polled: [], conversation: "acordo-1042", channel: null });
    // The channel was never opened, so a machine with no emulator running
    // still gets a clean answer.
    expect(out.stderr).not.toContain("emulator backend");
  });

  it("refuses --conversation on the terminal channel rather than quietly ignoring it", () => {
    const out = agent(["poll", "--conversation", "acordo-1042", "--json"], scratch("flag"));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("belong to --channel whatsapp");
  });

  it("refuses a flag it does not know, so a typo is not a silently different run", () => {
    const out = agent(["poll", "--chanel", "whatsapp"], scratch("typo"));
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("unknown argument --chanel");
  });
});
