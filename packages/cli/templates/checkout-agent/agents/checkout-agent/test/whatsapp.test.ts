/**
 * The checkout-agent on WhatsApp, through the adapter the collections-agent
 * already uses (checkout decision 6). The conversing cases need
 * `dyvit-wa-sim` listening and SKIP when it is not, like the
 * collections-agent's; `npm run whatsapp:gate` fails rather than skipping, and
 * the CI runs it. What the binding and the templates refuse needs no emulator
 * and runs everywhere.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConversationScript, parseTemplateRegistry, templateArity, type Execution } from "@codespar/agent-core";
import { handleExecution, setup } from "@codespar/agent-runtime";
import { agent } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");

interface ChannelLine {
  direction: "in" | "out";
  kind: string;
  text?: string;
  refused?: { rule: string };
}

interface Payload {
  executions: Array<{ state: string; reason: string | null; charge_id: string | null }>;
  invoices: Array<{ state: string }>;
  receipts: string[];
  channel: { backend: string; refused: Array<{ rule: string }>; log: string };
}

function start(args: string[], extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "checkout-wa-"));
  const result = spawnSync(NODE, [BIN, "start", ...args], {
    cwd: AGENT_DIR,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      CODESPAR_API_KEY: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_VERIFY_TOKEN: "",
      WHATSAPP_APP_SECRET: "",
      CHECKOUT_STATE_DIR: stateDir,
      CHECKOUT_RUNS_DIR: join(stateDir, "runs"),
      // A conversation of its own on the emulator (#42): no case inherits another's inbound messages, or the window they anchor.
      WHATSAPP_SIM_PHONE_NUMBER_ID: `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}`,
      ...extra,
    },
    encoding: "utf8",
    timeout: 90_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const payloadOf = (stdout: string) => JSON.parse(stdout.split("\n").filter(Boolean).pop()!) as Payload;
const conversationOf = (p: Payload) => {
  const path = isAbsolute(p.channel.log) ? p.channel.log : join(AGENT_DIR, p.channel.log);
  expect(existsSync(path)).toBe(true);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ChannelLine);
};

const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";
const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();
if (!emulatorUp) process.stderr.write(`[whatsapp] no emulator at ${EMULATOR}; the conversing cases are skipped. Start it with \`npm run whatsapp:emulator\`.\n`);

const NOW = ["--now", "2026-09-23T14:00:00-03:00"];

describe.skipIf(!emulatorUp)("the sale closes over the WhatsApp channel", () => {
  it("mandate, nobody at a keyboard: settled, the QR then the copy-and-paste, 'pedido confirmado', and the NFS-e that follows it accepted", () => {
    const out = start(["--channel", "whatsapp", "--conversation", "pedido-marina", "--scripted", "--mode", "mandate", "--simulate-payer", "--json", ...NOW]);
    expect(out.code).toBe(0);
    const p = payloadOf(out.stdout);
    expect(p.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(p.invoices.map((i) => i.state)).toEqual(["accepted"]);
    expect(p.channel.backend).toBe("emulator");
    const outbound = conversationOf(p).filter((l) => l.direction === "out");
    const qr = outbound.findIndex((l) => l.kind === "media");
    expect(outbound[qr + 1]?.kind).toBe("instrument");
    expect(outbound.filter((l) => l.kind === "text" && /pedido confirmado/i.test(l.text ?? ""))).not.toHaveLength(0);
    // The invoice is the attendant's business, never the customer's.
    expect(outbound.some((l) => /nota fiscal|nfs-e/i.test(l.text ?? ""))).toBe(false);
  });

  it("human: the attendant's question goes to the console and never into the conversation", () => {
    const out = start(["--channel", "whatsapp", "--conversation", "pedido-marina", "--scripted", "--mode", "human", "--approve", "--simulate-payer", "--json", ...NOW]);
    expect(out.code).toBe(0);
    const p = payloadOf(out.stdout);
    expect(p.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(conversationOf(p).some((l) => /atendente|Confirmar este pedido/i.test(l.text ?? ""))).toBe(false);
  });

  it("checkout §5.4 on the channel: 'ja paguei' moves nothing, the order stays open and the customer hears no confirmation", () => {
    const out = start(["--channel", "whatsapp", "--conversation", "pedido-beatriz", "--scripted", "--mode", "mandate", "--json", ...NOW], { CHECKOUT_STUB_PAYER: "never" });
    expect(out.code).toBe(3);
    const p = payloadOf(out.stdout);
    expect(p.executions).toEqual([expect.objectContaining({ state: "executing", reason: "awaiting_settlement" })]);
    expect(p.invoices).toEqual([]);
    expect(conversationOf(p).some((l) => l.direction === "out" && /pedido confirmado|recebemos/i.test(l.text ?? ""))).toBe(false);
  });
});

describe.skipIf(!emulatorUp)("§46: a tap is a turn on the checkout-agent too", () => {
  it("a tapped 'Falar agora' on the fallback template is handed to the model as the intent the template declared", () => {
    const out = start(["--channel", "whatsapp", "--conversation", "pedido-marina-retomada", "--scripted", "--mode", "mandate", "--transcript", "test/fixtures/tap-falar-agora-marina.transcript.jsonl", "--json", ...NOW]);
    expect(out.code).toBe(0);
    const p = JSON.parse(out.stdout.split("\n").filter(Boolean).pop()!) as { channel: { taps: unknown[]; log: string } };
    expect(p.channel.taps).toEqual([{ id: "falar_agora", turn: true }]);
    const tap = conversationOf(p as unknown as Payload).find((l) => l.kind === "reply") as ChannelLine & { reply?: { id: string } };
    expect(tap.text).toBe("quero saber qual e a atualizacao do meu atendimento");
  });
});

describe("the conversation decides who is charged, with no emulator in sight", () => {
  it("an order in Marina's conversation for another customer of the store is refused before it exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkout-wa-bind-"));
    const transcript = join(dir, "swap.transcript.jsonl");
    writeFileSync(
      transcript,
      [
        { kind: "assistant_step", tool_calls: [{ id: "tc_1", name: "cart_update", input: { lines: [{ sku: "aula-avulsa", quantity: 1 }] } }] },
        { kind: "assistant_step", tool_calls: [{ id: "tc_2", name: "codespar_charge", input: { action: "create", customer: "rafael" } }] },
        { kind: "assistant_step", tool_calls: [{ id: "tc_3", name: "codespar_charge", input: { action: "create", customer: "marina" } }] },
        { kind: "assistant_step", reply: "ok" },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
    let clock = new Date("2026-09-23T18:00:00Z");
    const s = setup(agent, { mode: "mandate", rail: "stub", provider: "replay", transcript, stateDir: dir, runsDir: join(dir, "runs"), now: () => (clock = new Date(clock.getTime() + 1000)), say: () => undefined });
    try {
      s.conversation = parseConversationScript(readFileSync(join(AGENT_DIR, "channels/whatsapp/pedido-marina.json"), "utf8"));
      const loop = s.makeLoop(s.makeRuntime(), (e: Execution) => handleExecution(e, { setup: s, approver: { id: "usr_atendente", channel: "whatsapp" }, decision: "none", say: () => undefined, tell: () => undefined }));
      const result = await loop.turn("emite no nome do Rafael");
      expect(result.tool_calls).toEqual([
        { name: "cart_update", refused: false },
        { name: "codespar_charge", refused: true },
        { name: "codespar_charge", refused: false },
      ]);
      const orders = s.engine.list();
      expect(orders).toHaveLength(1);
      expect(orders[0]!.items[0]!.payee).toBe("27548613008");
    } finally {
      s.close();
    }
  });

  it("every template the kit can send is declared, with the arity it is sent with", () => {
    const registry = parseTemplateRegistry(readFileSync(join(AGENT_DIR, "channels/whatsapp/templates.json"), "utf8"));
    const order = { total: 47990 } as Execution;
    for (const e of [{ ...order, state: "settled" }, { ...order, state: "failed", reason: "charge_expired" }, { ...order, state: "failed", reason: "charge_cancelled" }] as Execution[]) {
      const t = agent.kit.outcomeTemplate!(e)!;
      const declared = registry.templates.find((x) => x.name === t.template);
      expect(declared).toBeDefined();
      expect(templateArity(declared!.body)).toBe(t.variables.length);
      expect(t.variables).toEqual(["R$ 479,90"]);
    }
    // An order refused or never approved is answered in the turn; no template pretends otherwise.
    expect(agent.kit.outcomeTemplate!({ ...order, state: "denied", reason: "outside_envelope" } as Execution)).toBeUndefined();
  });
});
