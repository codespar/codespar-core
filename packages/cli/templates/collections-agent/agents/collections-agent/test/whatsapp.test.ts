/**
 * The collections-agent on the channel it was written for.
 *
 * Every case here runs a real process: no key of either kind, and the
 * WHATSAPP_* variables explicitly blanked, so a machine that happens to have
 * Meta credentials in its shell runs the same test as the CI.
 *
 * The cases that actually converse need `dyvit-wa-sim` listening — the local
 * Cloud API emulator the channel's `simulator` backend talks to — and SKIP
 * when it is not, so `npm test` is green on a machine that never started it.
 * The CI starts it, and `npm run whatsapp:gate` fails rather than skipping, so
 * the thing that matters never hides behind a skip. The cases that check what
 * the channel REFUSES to be asked need no emulator: those refusals happen
 * before anything is opened, and they run everywhere.
 *
 * What is asserted is the final state and the shape of the conversation, never
 * the wording — the copy-and-paste as its own message, the operator's question
 * nowhere near the debtor, nothing at all outside the collection hours.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

interface ChannelLine {
  direction: "in" | "out";
  kind: string;
  text?: string;
  contact: string;
  state: string;
  message_id: string;
  refused?: { rule: string };
}

interface Payload {
  executions: Array<{ state: string; charges: Array<{ charge_id: string | null }> }>;
  receipts: string[];
  channel: { backend: string; conversation: string; turns: number; messages_in: number; messages_out: number; refused: Array<{ rule: string }>; log: string };
}

function run(args: string[], extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "collections-wa-"));
  const result = spawnSync(NODE, [BIN, "start", ...args], {
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
      COLLECTIONS_STATE_DIR: stateDir,
      COLLECTIONS_RUNS_DIR: join(stateDir, "runs"),
      ...extra,
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function payloadOf(stdout: string): Payload {
  const lines = stdout.split("\n").filter(Boolean);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Payload;
}

function conversationOf(payload: Payload): ChannelLine[] {
  const path = isAbsolute(payload.channel.log) ? payload.channel.log : join(AGENT_DIR, payload.channel.log);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChannelLine);
}

const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";
/** Probed at module level: `describe.skipIf` is read when the file is collected, before any hook runs. */
const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!emulatorUp) process.stderr.write(`[whatsapp] no emulator at ${EMULATOR}; the conversing cases are skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

const INSIDE_HOURS = ["--now", "2026-09-23T14:00:00-03:00"];
const AFTER_HOURS = ["--now", "2026-09-23T22:30:00-03:00"];
const SCRIPTED = ["--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--simulate-payer", "--json"];

describe.skipIf(!emulatorUp)("the cycle closes over the WhatsApp channel", () => {
  it("settles in mandate mode with nobody at a keyboard, and sends the QR with the copy-and-paste under it", () => {
    const out = run([...SCRIPTED, "--mode", "mandate", ...INSIDE_HOURS]);
    expect(out.code).toBe(0);
    const payload = payloadOf(out.stdout);
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(payload.executions[0]!.charges).toHaveLength(1);
    expect(payload.receipts).toHaveLength(1);
    expect(payload.channel.backend).toBe("emulator");
    // The one expected refusal: neither backend can upload the QR image.
    expect(payload.channel.refused.map((r) => r.rule)).toEqual(["media_upload_unimplemented"]);

    const conversation = conversationOf(payload);
    const outbound = conversation.filter((l) => l.direction === "out");
    const qr = outbound.findIndex((l) => l.kind === "media");
    expect(qr).toBeGreaterThanOrEqual(0);
    expect(outbound[qr + 1]!.kind).toBe("instrument");
    expect(outbound[qr + 1]!.text).toMatch(/^00020126/);
    expect(conversation.filter((l) => l.direction === "in")).toHaveLength(2);
    // Every delivered message carries a provider id: it went through the Cloud API surface, not around it.
    for (const line of outbound.filter((l) => !l.refused)) expect(line.message_id).toMatch(/^wamid\./);
  });

  it("settles in human mode too, and the operator's question never reaches the debtor", () => {
    const out = run([...SCRIPTED, "--mode", "human", "--approve", ...INSIDE_HOURS]);
    expect(out.code).toBe(0);
    const payload = payloadOf(out.stdout);
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    // The question is the operator's and is on the console; nothing like it is in the conversation.
    for (const line of conversationOf(payload)) expect(line.text ?? "").not.toMatch(/operador|Aprovar a emissao/i);
  });

  it("writes the conversation into the bundle with the contact masked", () => {
    const out = run([...SCRIPTED, "--mode", "mandate", ...INSIDE_HOURS]);
    const conversation = conversationOf(payloadOf(out.stdout));
    expect(conversation.length).toBeGreaterThan(0);
    for (const line of conversation) {
      expect(line.contact).not.toContain("987654321");
      expect(line.contact).toContain("****");
    }
  });

  it("tells the person once when the charge expires, and writes no record", () => {
    const out = run(["--channel", "whatsapp", "--conversation", "acordo-1103", "--scripted", "--mode", "mandate", "--payer", "expires", "--json", ...INSIDE_HOURS]);
    const payload = payloadOf(out.stdout);
    expect(payload.executions.map((e) => e.state)).toEqual(["failed"]);
    expect(payload.receipts).toEqual([]);
    expect(payload.channel.conversation).toBe("acordo-1103");
    // The QR still went out: it was payable, nobody paid it.
    const outbound = conversationOf(payload).filter((l) => l.direction === "out");
    expect(outbound.some((l) => l.kind === "media")).toBe(true);
    // The kit's one-per-outcome message, sent once however many looks carried the event.
    // The model's own reply also says the charge expired, which is the terminal's behaviour too.
    expect(outbound.filter((l) => String(l.text ?? "").startsWith("A cobranca venceu sem pagamento"))).toHaveLength(1);
  });

  it("refuses to say anything at all outside the collection hours, and issues nothing", () => {
    const out = run([...SCRIPTED, "--mode", "mandate", ...AFTER_HOURS]);
    const payload = payloadOf(out.stdout);
    expect(payload.channel.messages_out).toBe(0);
    // The emulator would have accepted every one of them: the collection hours are OUR rule, not WhatsApp's.
    expect(payload.channel.refused.map((r) => r.rule)).toContain("collection_hours");
    expect(payload.executions.flatMap((e) => e.charges)).toEqual([]);
    expect(payload.receipts).toEqual([]);
  });
});

describe("what the channel refuses to be asked", () => {
  it("refuses the cloud-api backend by naming every credential this repo does not ship", () => {
    const out = run(["--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--backend", "cloud-api", "--mode", "mandate", ...INSIDE_HOURS]);
    expect(out.code).toBe(1);
    for (const name of ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]) {
      expect(out.stderr).toContain(name);
    }
    expect(out.stderr).toContain("emulator");
  });

  it("refuses --input on a channel: a conversation takes its turns from the conversation", () => {
    const out = run(["--channel", "whatsapp", "--input", "oi", "--json"]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--input");
  });

  it("refuses the channel flags on the terminal", () => {
    expect(run(["--backend", "simulator", "--input", "oi"]).code).toBe(2);
    expect(run(["--conversation", "acordo-1042", "--input", "oi"]).code).toBe(2);
  });

  it("refuses a scripted human-mode run rather than waiting on a keyboard nobody is at", () => {
    const out = run(["--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--mode", "human", "--json", ...INSIDE_HOURS]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--approve");
  });

  it("asks which conversation when the agent ships more than one: which debtor is not a default", () => {
    const out = run(["--channel", "whatsapp", "--scripted", "--json", ...INSIDE_HOURS]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("--conversation is required");
    expect(out.stderr).toContain("acordo-1103");
  });

  it("refuses a conversation the agent does not ship", () => {
    const out = run(["--channel", "whatsapp", "--scripted", "--conversation", "acordo-9999", "--json", ...INSIDE_HOURS]);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("acordo-1042");
  });
});

describe("the terminal is untouched", () => {
  it("still runs the same one-shot with no channel flag", () => {
    const out = run(["--input", "fechado, pago à vista", "--transcript", "test/fixtures/accept-1042.transcript.jsonl", "--approve", "--simulate-payer", "--json", ...INSIDE_HOURS]);
    expect(out.code).toBe(0);
    const payload = JSON.parse(out.stdout.split("\n").filter(Boolean)[0]!) as Payload & { channel?: unknown };
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    // No channel key: a terminal run is not a channel run, and its JSON shape did not change.
    expect(payload.channel).toBeUndefined();
  });
});
