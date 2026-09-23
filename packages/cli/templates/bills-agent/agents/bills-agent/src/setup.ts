/**
 * Wires the core for this agent: manifest, guardrails, mandate, state,
 * rail, status source, signer, bundle, provider. Everything the commands
 * and the terminal channel share.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalMandateStatusStub,
  AgentLoop,
  ApiMandateStatusSource,
  CodeSparRail,
  ExecutionEngine,
  ProofBundle,
  ReplayRuntime,
  StateStore,
  StubRail,
  createCodeSparClient,
  isTestKey,
  loadGuardrails,
  loadManifest,
  loadMandate,
  loadOrCreateLocalApprovalKey,
  loadToolsFile,
  newRunId,
  NotATestKeyError,
  type AgentRuntime,
  type ApprovalMode,
  type Execution,
  type LoadedManifest,
  type Mandate,
  type MandateStatusSource,
  type PaymentRail,
  type StubRailOptions,
  type ToolHandler,
} from "@codespar/agent-core";
import { AnthropicRuntime } from "@codespar/agent-core/providers/anthropic";
import type { ApiClient } from "@codespar/sdk";
import { codesparLedger, codesparPay, listBills } from "./modules/pix-out.js";
import { loadLocalMandate } from "./modules/embedded-consent.js";

export const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = join(AGENT_DIR, ".codespar");
export const RUNS_DIR = join(AGENT_DIR, "runs");
export const MANDATE_PATH = join(STATE_DIR, "mandate.json");

/** The runs folder in use: the agent's own, or the scratch one the restart test points at. */
export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["BILLS_RUNS_DIR"] ?? RUNS_DIR;
}

export type RailKind = "stub" | "api";

export interface SetupOptions {
  mode?: ApprovalMode | undefined;
  rail?: RailKind | undefined;
  provider?: "anthropic" | "replay" | undefined;
  transcript?: string | undefined;
  runId?: string | undefined;
  runsDir?: string | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  stubRail?: StubRailOptions | undefined;
  /** Use this mandate instead of the local or example one (scenarios). */
  mandate?: Mandate | undefined;
  env?: NodeJS.ProcessEnv;
  say?: ((line: string) => void) | undefined;
}

export interface Setup {
  manifest: LoadedManifest;
  mode: ApprovalMode;
  mandate: Mandate;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: PaymentRail;
  railKind: RailKind;
  api: ApiClient | undefined;
  status: MandateStatusSource;
  bundle: ProofBundle;
  runId: string;
  engine: ExecutionEngine;
  system: string;
  handlers: Record<string, ToolHandler>;
  tools: ReturnType<typeof loadToolsFile>;
  makeLoop(runtime: AgentRuntime, onExecution: (execution: Execution) => Promise<Execution>): AgentLoop;
  makeRuntime(): AgentRuntime;
  close(): void;
}

export function readDotEnv(agentDir = AGENT_DIR): void {
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function resolveRailKind(env: NodeJS.ProcessEnv, requested: RailKind | undefined): RailKind {
  if (requested) return requested;
  const key = env["CODESPAR_API_KEY"];
  if (!key || key === "csk_test_your_key_here") return "stub";
  return "api";
}

export function setup(options: SetupOptions = {}): Setup {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line: string) => process.stderr.write(line + "\n"));
  const manifest = loadManifest(join(AGENT_DIR, "agent.yaml"));
  const guardrails = loadGuardrails(manifest.resolvePath(manifest.manifest.guardrails));
  const tools = loadToolsFile(manifest.resolvePath(manifest.manifest.tools));
  const system = readFileSync(join(AGENT_DIR, "SYSTEM_PROMPT.md"), "utf8");
  const mode: ApprovalMode = options.mode ?? manifest.manifest.default_approval;
  if (!manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);

  // BILLS_STATE_DIR / BILLS_RUNS_DIR exist for the restart test, which drives a child process over a scratch state.
  const stateDir = options.stateDir ?? env["BILLS_STATE_DIR"] ?? STATE_DIR;
  const runs = options.runsDir ?? runsDir(env);
  const store = new StateStore(join(stateDir, "state.db"));
  const gate = new LocalMandateStatusStub(store, options.now);
  const signer = loadOrCreateLocalApprovalKey(stateDir);

  const railKind = resolveRailKind(env, options.rail);
  let api: ApiClient | undefined;
  let rail: PaymentRail;
  let status: MandateStatusSource = gate;
  let mandate: Mandate;
  if (railKind === "api") {
    if (!isTestKey(env["CODESPAR_API_KEY"])) throw new NotATestKeyError();
    api = createCodeSparClient({ apiKey: env["CODESPAR_API_KEY"], baseUrl: env["CODESPAR_API_URL"], projectId: env["CODESPAR_PROJECT_ID"] });
    const local = options.mandate ?? loadLocalMandate(MANDATE_PATH);
    if (!local) throw new NoMandateError();
    mandate = local;
    rail = new CodeSparRail(api, { canonical: mandate.canonical, signature: mandate.signature });
    // Section 4.7 against the real status: the local stub answers only runs without a key.
    status = new ApiMandateStatusSource(api, options.now);
  } else {
    // BILLS_KILL_AFTER_DISPATCH=1 simulates a crash right after the rail accepted the attempt and before the outcome was recorded.
    const killAfterDispatch = env["BILLS_KILL_AFTER_DISPATCH"] === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // BILLS_STUB_REFUSE=<payee,payee>: the stub rail refuses these payees, to drive a partial failure from a test process.
    const refuse = env["BILLS_STUB_REFUSE"] ? { refusePayees: env["BILLS_STUB_REFUSE"].split(",").map((p) => p.trim()).filter(Boolean) } : {};
    rail = new StubRail(store, { ...(options.now ? { clock: options.now } : {}), ...killAfterDispatch, ...refuse, ...(options.stubRail ?? {}) });
    mandate = options.mandate ?? loadMandate(manifest.resolvePath(manifest.manifest.mandate_schema));
  }

  const runId = options.runId ?? newRunId(mode);
  const bundle = new ProofBundle(runs, runId);
  bundle.mandateSnapshot(mandate);
  bundle.meta({ run_id: runId, agent: `${manifest.manifest.name}@${manifest.manifest.version}`, mode, rail: railKind, mandate_id: mandate.id, started_at: (options.now ?? (() => new Date()))().toISOString() });

  const engine = new ExecutionEngine({
    store,
    rail,
    status,
    signer,
    manifest: manifest.manifest,
    guardrails: { ...guardrails, approval: mode },
    mandate,
    bundle,
    mode,
    runId,
    onBehalfOf: mandate.consumer_id,
    ...(options.now ? { clock: options.now } : {}),
  });

  const handlers: Record<string, ToolHandler> = { codespar_pay: codesparPay, codespar_ledger: codesparLedger, list_bills: listBills };

  const makeRuntime = (): AgentRuntime => {
    const provider = options.provider ?? (env["ANTHROPIC_API_KEY"] && env["ANTHROPIC_API_KEY"] !== "sk-ant-your_key_here" ? "anthropic" : "replay");
    if (provider === "anthropic") return new AnthropicRuntime({ apiKey: env["ANTHROPIC_API_KEY"] });
    if (!options.transcript) throw new Error("the replay provider needs a transcript (--transcript <file> or --scenario <name>)");
    say(`[replay] no ANTHROPIC_API_KEY: replaying ${options.transcript}`);
    return ReplayRuntime.fromFile(options.transcript);
  };

  return {
    manifest,
    mode,
    mandate,
    store,
    gate,
    rail,
    railKind,
    api,
    status,
    bundle,
    runId,
    engine,
    system,
    handlers,
    tools,
    makeRuntime,
    makeLoop: (runtime, onExecution) => new AgentLoop({ runtime, tools, handlers, system, bundle, engine, onExecution, ...(options.now ? { clock: options.now } : {}) }),
    close: () => store.close(),
  };
}

export class NoMandateError extends Error {
  constructor() {
    super("no signed mandate yet: run `npm run consent` (or `npm start`, which starts the consent when a test key is present)");
    this.name = "NoMandateError";
  }
}
