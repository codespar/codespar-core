/**
 * Wires the core for one agent: manifest, guardrails, mandate, state, rail,
 * status source, signer, bundle, provider. Everything the commands and the
 * terminal channel share, whatever the agent is; what the agent brings is the
 * rail, the tool handlers and the policy extension, through its kit.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentLoop,
  ExecutionEngine,
  LocalMandateStatusStub,
  ProofBundle,
  ReplayRuntime,
  StateStore,
  loadGuardrails,
  loadManifest,
  loadOrCreateLocalApprovalKey,
  loadToolsFile,
  newRunId,
  resolveFixedClock,
  type AgentRuntime,
  type ApprovalMode,
  type Execution,
  type Guardrails,
  type LoadedManifest,
  type Mandate,
  type MandateStatusSource,
  type PaymentRail,
  type StubChargeRailOptions,
  type StubRailOptions,
  type ToolHandler,
} from "@codespar/agent-core";
import { AnthropicRuntime } from "@codespar/agent-core/providers/anthropic";
import type { ApiClient } from "@codespar/sdk";
import { envName, type Agent } from "./agent.js";
import type { AgentKit, RailKind, SandboxPayer, Settlement } from "./kit.js";

/** The `.env.example` placeholder counts as no key: a copied example must replay, not call Anthropic with a fake key. */
export const ANTHROPIC_KEY_PLACEHOLDER = "sk-ant-your_key_here";
export const CODESPAR_KEY_PLACEHOLDER = "csk_test_your_key_here";

export type ProviderKind = "anthropic" | "replay";

export function stateDirOf(agent: Agent): string {
  return join(agent.dir, ".codespar");
}

export function mandatePathOf(agent: Agent): string {
  return join(stateDirOf(agent), "mandate.json");
}

/** The runs folder in use: the agent's own, or the scratch one the restart test points at. */
export function runsDir(agent: Agent, env: NodeJS.ProcessEnv = process.env): string {
  return env[envName(agent, "RUNS_DIR")] ?? join(agent.dir, "runs");
}

export interface SetupOptions {
  mode?: ApprovalMode | undefined;
  rail?: RailKind | undefined;
  provider?: ProviderKind | undefined;
  transcript?: string | undefined;
  runId?: string | undefined;
  runsDir?: string | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  stubRail?: StubRailOptions | StubChargeRailOptions | undefined;
  /** Use this mandate instead of the local or the example one (scenarios, tests). */
  mandate?: Mandate | undefined;
  env?: NodeJS.ProcessEnv;
  say?: ((line: string) => void) | undefined;
}

export interface Setup {
  agent: Agent;
  kit: AgentKit;
  settlement: Settlement;
  manifest: LoadedManifest;
  guardrails: Guardrails;
  mode: ApprovalMode;
  mandate: Mandate;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: PaymentRail;
  railKind: RailKind;
  api: ApiClient | undefined;
  status: MandateStatusSource;
  /** `await-payer` agents only: who plays the counterparty in the sandbox. */
  payer: SandboxPayer | undefined;
  /** Milliseconds between two looks at an issued receivable: 0 on the stub. */
  pollIntervalMs: number;
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

export function readDotEnv(agentDir: string): void {
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    const value = (m[2] ?? "").replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

export function resolveProvider(env: NodeJS.ProcessEnv, requested: ProviderKind | undefined): ProviderKind {
  if (requested) return requested;
  const key = env["ANTHROPIC_API_KEY"]?.trim();
  return key && key !== ANTHROPIC_KEY_PLACEHOLDER ? "anthropic" : "replay";
}

export function resolveRailKind(env: NodeJS.ProcessEnv, requested: RailKind | undefined): RailKind {
  if (requested) return requested;
  const key = env["CODESPAR_API_KEY"];
  if (!key || key === CODESPAR_KEY_PLACEHOLDER) return "stub";
  return "api";
}

export function setup(agent: Agent, options: SetupOptions = {}): Setup {
  const env = options.env ?? process.env;
  const say = options.say ?? ((line: string) => process.stderr.write(line + "\n"));
  // `--now` on the one-shot, or CODESPAR_AGENT_NOW for every command: the clock the engine, the stubs, the gate and the loop read (#16).
  const now = options.now ?? resolveFixedClock(undefined, env);
  const manifest = loadManifest(join(agent.dir, "agent.yaml"));
  const guardrails = loadGuardrails(manifest.resolvePath(manifest.manifest.guardrails));
  const tools = loadToolsFile(manifest.resolvePath(manifest.manifest.tools));
  const system = readFileSync(join(agent.dir, "SYSTEM_PROMPT.md"), "utf8");
  const mode: ApprovalMode = options.mode ?? manifest.manifest.default_approval;
  if (!manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);

  // <PREFIX>_STATE_DIR / <PREFIX>_RUNS_DIR exist for the restart test, which drives a child process over a scratch state.
  const stateDir = options.stateDir ?? env[envName(agent, "STATE_DIR")] ?? stateDirOf(agent);
  const runs = options.runsDir ?? runsDir(agent, env);
  const store = new StateStore(join(stateDir, "state.db"));
  const gate = new LocalMandateStatusStub(store, now);
  const signer = loadOrCreateLocalApprovalKey(stateDir);

  const railKind = resolveRailKind(env, options.rail);
  const built = agent.kit.buildRail({
    kind: railKind,
    env,
    agentDir: agent.dir,
    stateDir,
    manifest,
    store,
    gate,
    now,
    mandate: options.mandate,
    stubRail: options.stubRail,
    envVar: (name) => env[envName(agent, name)],
  });
  const { rail, mandate } = built;
  const status = built.status ?? gate;

  const runId = options.runId ?? newRunId(mode);
  const bundle = new ProofBundle(runs, runId);
  bundle.mandateSnapshot(mandate);
  // Section 11: mode, rail and mandate id. The VERSION rides with the id, so a reader knows which signing of the mandate authorised the run without opening the snapshot.
  bundle.meta({ run_id: runId, agent: `${manifest.manifest.name}@${manifest.manifest.version}`, mode, rail: railKind, mandate_id: mandate.id, mandate_version: mandate.version, started_at: (now ?? (() => new Date()))().toISOString() });

  const policyExtension = agent.kit.policyExtension?.({ agentDir: agent.dir, manifest, guardrails });
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
    ...(policyExtension ? { policyExtension } : {}),
    ...(now ? { clock: now } : {}),
  });

  const makeRuntime = (): AgentRuntime => {
    const provider = resolveProvider(env, options.provider);
    if (provider === "anthropic") return new AnthropicRuntime({ apiKey: env["ANTHROPIC_API_KEY"] });
    if (!options.transcript) throw new Error("the replay provider needs a transcript (--transcript <file> or --scenario <name>)");
    say(`[replay] no ANTHROPIC_API_KEY: replaying ${options.transcript}`);
    return ReplayRuntime.fromFile(options.transcript);
  };

  const s: Setup = {
    agent,
    kit: agent.kit,
    settlement: agent.settlement,
    manifest,
    guardrails,
    mode,
    mandate,
    store,
    gate,
    rail,
    railKind,
    api: built.api,
    status,
    payer: built.payer,
    pollIntervalMs: built.pollIntervalMs ?? 0,
    bundle,
    runId,
    engine,
    system,
    handlers: {},
    tools,
    makeRuntime,
    makeLoop: (runtime, onExecution) => new AgentLoop({ runtime, tools, handlers: s.handlers, system, bundle, engine, onExecution, ...(now ? { clock: now } : {}) }),
    close: () => store.close(),
  };
  s.handlers = agent.kit.handlers(s);
  return s;
}

export class NoMandateError extends Error {
  constructor() {
    super("no signed mandate yet: run `npm run consent -- --yes` first (or `npm start` without --input, which starts the consent when a test key is present)");
    this.name = "NoMandateError";
  }
}
