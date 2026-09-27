/**
 * §46's three product gaps on the collections-agent, in real processes
 * against the emulator: the confirmation of a paid agreement that the provider
 * reports FAILED is not an agreement the debtor was told about; an outcome the
 * kit has no template for goes out as the registry's fallback; and a tapped
 * "Emitir nova" is a turn, as the intent the template declared. Each case runs
 * in a conversation of its own (#42). They SKIP without the emulator; the gate
 * does not.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { pollWhatsApp, setup } from "@codespar/agent-runtime";
import { agent as collections } from "../src/kit.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const NODE = process.execPath;
const BIN = resolve(AGENT_DIR, "../../packages/agent-runtime/bin.mjs");
const EMULATOR = process.env["WHATSAPP_SIM_URL"] ?? "http://127.0.0.1:4290";
const TUESDAY = "2026-09-23T14:00:00-03:00";
const AFTER_WINDOW = new Date(new Date(TUESDAY).getTime() + 26 * 3600_000).toISOString();
const AGREED = "test/fixtures/agreed-1042-awaiting-payer.transcript.jsonl";
const CONTACT = "5511987654321";

const emulatorUp = await (async () => {
  try {
    return (await fetch(`${EMULATOR}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
})();

function scratch(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `collections-wa-sr-${label}-`));
  return { COLLECTIONS_STATE_DIR: stateDir, COLLECTIONS_RUNS_DIR: join(stateDir, "runs"), WHATSAPP_SIM_PHONE_NUMBER_ID: `9${String(Math.floor(Math.random() * 1e11)).padStart(11, "0")}` };
}

const baseEnv = (env: Record<string, string>) => ({ ...process.env, ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "", WHATSAPP_PHONE_NUMBER_ID: "", WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_VERIFY_TOKEN: "", WHATSAPP_APP_SECRET: "", ...env });

function run(args: string[], env: Record<string, string>) {
  const r = spawnSync(NODE, [BIN, ...args], { cwd: AGENT_DIR, env: baseEnv(env), encoding: "utf8", timeout: 90_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lastJson = (stdout: string) => JSON.parse(stdout.split("\n").filter(Boolean).pop()!) as Record<string, unknown>;

async function sim(path: string, body?: unknown) {
  const r = await fetch(`${EMULATOR}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as Record<string, unknown>;
}

function events(env: Record<string, string>, type: string): Array<{ execution_id: string | null; payload: Record<string, unknown> }> {
  const db = new DatabaseSync(join(env["COLLECTIONS_STATE_DIR"]!, "state.db"));
  try {
    return (db.prepare("SELECT execution_id, payload FROM events WHERE type = ?").all(type) as Array<{ execution_id: string | null; payload: string }>).map((r) => ({ execution_id: r.execution_id, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

/** A log path is relative to the cwd of whoever wrote it: the agent's directory for a child process, this process's for an in-process poll. */
function channelLog(logPath: string, base = AGENT_DIR): Array<Record<string, unknown>> {
  const path = isAbsolute(logPath) ? logPath : resolve(base, logPath);
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe.skipIf(!emulatorUp)("§46 on the collections-agent, against the emulator", () => {
  it("the paid-agreement template the provider reports FAILED (131026) is not an agreement the debtor was told about", { timeout: 60_000 }, async () => {
    const env = scratch("failed");
    expect(run(["start", "--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--mode", "mandate", "--transcript", AGREED, "--now", TUESDAY, "--json"], { ...env, COLLECTIONS_STUB_PAYER: "never" }).code).toBe(3);
    await sim("/_sim/clock", { advance_hours: 26 });

    // The poll, in its own process, with a long enough wait for the status the provider reports after the send.
    const child = spawn(NODE, [BIN, "poll", "--channel", "whatsapp", "--conversation", "acordo-1042", "--simulate-payer", "--now", AFTER_WINDOW, "--json"], { cwd: AGENT_DIR, env: baseEnv({ ...env, WHATSAPP_STATUS_GRACE_MS: "6000" }) });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const exit = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

    // As soon as the confirmation template exists at the provider, the provider reports it failed.
    const key = `${env["WHATSAPP_SIM_PHONE_NUMBER_ID"]}:${CONTACT}`;
    let template: string | undefined;
    for (let i = 0; i < 200 && !template; i += 1) {
      const state = (await sim(`/_sim/state?key=${key}`)) as { messages?: Array<{ id: string; direction: string; kind: string }> };
      template = state.messages?.find((m) => m.direction === "business_to_user" && m.kind === "template")?.id;
      if (!template) await new Promise((r) => setTimeout(r, 50));
    }
    expect(template).toBeDefined();
    await sim("/_sim/status", { status: "failed", message_id: template, reason: "not on whatsapp" });

    expect(await exit).toBe(1);
    const polled = (lastJson(stdout)["polled"] as Array<{ state: string; delivery: { told: boolean; reason?: string } }>)[0]!;
    // The cycle closed: the money is where the rail says it is. The telling of it did not happen.
    expect(polled.state).toBe("settled");
    expect(polled.delivery).toMatchObject({ told: false, reason: "delivery_failed" });
    const failed = events(env, "message.debtor.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ message_id: template, state: "settled" });
    expect((failed[0]!.payload["errors"] as Array<{ code: number }>)[0]!.code).toBe(131026);
  });

  it("an outcome the kit has no template for goes out as the registry's fallback, which states no outcome", { timeout: 60_000 }, async () => {
    const env = scratch("fallback");
    expect(run(["start", "--channel", "whatsapp", "--conversation", "acordo-1042", "--scripted", "--mode", "mandate", "--transcript", AGREED, "--now", TUESDAY, "--json"], { ...env, COLLECTIONS_STUB_PAYER: "never" }).code).toBe(3);
    await sim("/_sim/clock", { advance_hours: 26 });

    // The same agent with no copy for any outcome: what a kit that never wrote one looks like to the poll.
    const bare = { ...collections, kit: { ...collections.kit, outcomeTemplate: () => undefined } };
    const saved = { ...process.env };
    Object.assign(process.env, { ...env, COLLECTIONS_STATE_DIR: env["COLLECTIONS_STATE_DIR"], ANTHROPIC_API_KEY: "", CODESPAR_API_KEY: "" });
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
    const s = setup(bare, { mode: "mandate", rail: "stub", stateDir: env["COLLECTIONS_STATE_DIR"]!, runsDir: env["COLLECTIONS_RUNS_DIR"]!, now: () => new Date(AFTER_WINDOW), say: () => undefined });
    let code: number;
    try {
      code = await pollWhatsApp({ agent: bare, setup: s, conversation: "acordo-1042", backend: "simulator", json: true, simulatePayer: true, now: () => new Date(AFTER_WINDOW), say: () => undefined });
    } finally {
      process.stdout.write = write;
      s.close();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect(code).toBe(0);
    const payload = JSON.parse(written.join("").trim().split("\n").pop()!) as { polled: Array<{ delivery: Record<string, unknown> }>; channel: { log: string } };
    expect(payload.polled[0]!.delivery).toEqual({ told: true, carrier: "template", template: "atendimento_atualizacao", fallback: true });
    const last = channelLog(payload.channel.log, process.cwd()).filter((l) => l["direction"] === "out").at(-1)!;
    expect(String(last["text"])).toContain("atendimento_atualizacao");
    expect(last["offered"]).toEqual(["falar_agora"]);
    expect(events(env, "message.debtor").at(-1)!.payload).toMatchObject({ template: "atendimento_atualizacao", fallback: true });
  });

  it("a tapped 'Emitir nova' is a turn, and the model is handed the intent the template declared for it", { timeout: 60_000 }, () => {
    const env = scratch("tap");
    const out = run(["start", "--channel", "whatsapp", "--conversation", "acordo-1042-retomada", "--scripted", "--mode", "mandate", "--transcript", "test/fixtures/tap-emitir-nova-1042.transcript.jsonl", "--simulate-payer", "--now", TUESDAY, "--json"], env);
    expect(out.code).toBe(0);
    const payload = lastJson(out.stdout) as { run_id: string; executions: Array<{ state: string }>; channel: { taps: unknown[]; log: string } };
    expect(payload.executions.map((e) => e.state)).toEqual(["settled"]);
    expect(payload.channel.taps).toEqual([{ id: "emitir_nova", turn: true }]);
    const tap = channelLog(payload.channel.log).find((l) => l["kind"] === "reply")!;
    expect(tap).toMatchObject({ direction: "in", reply: { id: "emitir_nova", title: "Emitir nova" }, text: "quero que voce emita uma nova cobranca para o meu acordo" });
    // What the MODEL was handed: the declared intent, verbatim, as the person's turn.
    const transcript = readFileSync(join(env["COLLECTIONS_RUNS_DIR"]!, payload.run_id, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text?: string });
    expect(transcript.filter((t) => t.kind === "user").map((t) => t.text)).toEqual(["quero que voce emita uma nova cobranca para o meu acordo"]);
  });
});
