/**
 * Wires the core for this agent: manifest, guardrails, envelope, collection
 * policy, state, rail, status source, signer, bundle, provider. Everything
 * the commands and the terminal channel share.
 *
 * There is no consent step: the collection policy is the MERCHANT's own
 * (the receiving side has no API-signed policy today, section 16), so the
 * example file is the policy in both rails. With a test key the rail is the
 * CodeSpar sandbox (`POST /v1/charges`) and the payer is the sandbox route.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LocalMandateStatusStub,
  AgentLoop,
  CodeSparChargeRail,
  ExecutionEngine,
  ProofBundle,
  ReplayRuntime,
  StateStore,
  StubChargeRail,
  createCodeSparClient,
  isTestKey,
  loadGuardrails,
  loadManifest,
  loadMandate,
  loadOrCreateLocalApprovalKey,
  loadToolsFile,
  newRunId,
  NotATestKeyError,
  paySandboxCharge,
  type AgentRuntime,
  type ApprovalMode,
  type Execution,
  type LoadedManifest,
  type Mandate,
  type MandateStatusSource,
  type PaymentRail,
  type StubChargeRailOptions,
  type StubPayerBehaviour,
  type ToolHandler,
} from "@codespar/agent-core";
import { AnthropicRuntime } from "@codespar/agent-core/providers/anthropic";
import type { ApiClient } from "@codespar/sdk";
import { envelopePolicy, loadEnvelope, type Envelope } from "./envelope.js";
import { makeHandlers } from "./modules/bolepix-receivables.js";

export const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = join(AGENT_DIR, ".codespar");
export const RUNS_DIR = join(AGENT_DIR, "runs");

/** The runs folder in use: the agent's own, or the scratch one the restart test points at. */
export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env["COLLECTIONS_RUNS_DIR"] ?? RUNS_DIR;
}

export type RailKind = "stub" | "api";

/**
 * Who plays the debtor. With the stub rail it is the fixture inside the
 * rail; with a test key it is `POST /v1/test/charges/{id}/pay`, which the
 * kit calls only when a scenario or `--simulate-payer` asks for it.
 */
export interface SandboxPayer {
  kind: "stub" | "api";
  /** Pays a receivable this run issued. Returns what the payer reported, or the refusal. */
  pay(chargeId: string, attemptId: string): Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** Stub only: what the fixture does with receivables issued from now on. */
  behave(behaviour: StubPayerBehaviour): void;
}

export interface SetupOptions {
  mode?: ApprovalMode | undefined;
  rail?: RailKind | undefined;
  provider?: "anthropic" | "replay" | undefined;
  transcript?: string | undefined;
  runId?: string | undefined;
  runsDir?: string | undefined;
  stateDir?: string | undefined;
  now?: (() => Date) | undefined;
  stubRail?: StubChargeRailOptions | undefined;
  /** Use this policy instead of the example one (tests). */
  mandate?: Mandate | undefined;
  env?: NodeJS.ProcessEnv;
  say?: ((line: string) => void) | undefined;
}

export interface Setup {
  manifest: LoadedManifest;
  mode: ApprovalMode;
  mandate: Mandate;
  envelope: Envelope;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: PaymentRail;
  railKind: RailKind;
  api: ApiClient | undefined;
  payer: SandboxPayer;
  status: MandateStatusSource;
  bundle: ProofBundle;
  runId: string;
  engine: ExecutionEngine;
  system: string;
  handlers: Record<string, ToolHandler>;
  tools: ReturnType<typeof loadToolsFile>;
  /** Milliseconds between two looks at an issued receivable: 0 on the stub, a few seconds on the API. */
  pollIntervalMs: number;
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
  const envelope = loadEnvelope(guardrails);
  const tools = loadToolsFile(manifest.resolvePath(manifest.manifest.tools));
  const system = readFileSync(join(AGENT_DIR, "SYSTEM_PROMPT.md"), "utf8");
  const mode: ApprovalMode = options.mode ?? manifest.manifest.default_approval;
  if (!manifest.manifest.approval.includes(mode)) throw new Error(`agent.yaml does not support approval: ${mode}`);

  // COLLECTIONS_STATE_DIR / COLLECTIONS_RUNS_DIR exist for the restart test, which drives a child process over a scratch state.
  const stateDir = options.stateDir ?? env["COLLECTIONS_STATE_DIR"] ?? STATE_DIR;
  const runs = options.runsDir ?? runsDir(env);
  const store = new StateStore(join(stateDir, "state.db"));
  // The collection policy is the merchant's own file: there is no `GET /v1/mandates/{id}` to read for it, so the section 4.7 gate
  // is the local stub in BOTH rails (the bills-agent reads the API with a test key). See docs/OPEN_QUESTIONS.md section 25.
  const gate = new LocalMandateStatusStub(store, options.now);
  const signer = loadOrCreateLocalApprovalKey(stateDir);
  const mandate = options.mandate ?? loadMandate(manifest.resolvePath(manifest.manifest.mandate_schema));

  const railKind = resolveRailKind(env, options.rail);
  let api: ApiClient | undefined;
  let rail: PaymentRail;
  let payer: SandboxPayer;
  let pollIntervalMs: number;
  if (railKind === "api") {
    if (!isTestKey(env["CODESPAR_API_KEY"])) throw new NotATestKeyError();
    const client = createCodeSparClient({ apiKey: env["CODESPAR_API_KEY"], baseUrl: env["CODESPAR_API_URL"], projectId: env["CODESPAR_PROJECT_ID"] });
    api = client;
    rail = new CodeSparChargeRail(client);
    pollIntervalMs = 3000;
    payer = {
      kind: "api",
      async pay(chargeId) {
        const result = await paySandboxCharge(client, chargeId);
        if (!result.ok) return { ok: false, detail: `${result.failure.code}: ${result.failure.message}` };
        const s = result.state;
        return { ok: true, detail: `sandbox payer: ${s.charge_id} ${s.status} (${s.payment}, ${s.paid_minor} of ${s.quoted_minor}), simulated=${s.simulated}, settled_against=${s.settled_against}, money_moved=${s.money_moved}${s.idempotent_replay ? ", replay" : ""}` };
      },
      behave() {
        /* the API's payer is a route, not a fixture; a scenario that needs "expires" declares rails: [stub] */
      },
    };
  } else {
    // COLLECTIONS_KILL_AFTER_DISPATCH=1 simulates a crash right after the issuer accepted the charge and before the outcome was recorded.
    const killAfterDispatch = env["COLLECTIONS_KILL_AFTER_DISPATCH"] === "1" ? { afterDispatch: () => process.exit(137) } : {};
    // COLLECTIONS_STUB_PAYER=pays|expires|never: what the fixture payer does, from a test process.
    const behaviour = env["COLLECTIONS_STUB_PAYER"];
    const fixture: Pick<StubChargeRailOptions, "payer"> = behaviour === "pays" || behaviour === "expires" || behaviour === "never" ? { payer: behaviour } : {};
    const refuse = env["COLLECTIONS_STUB_REFUSE"] ? { refusePayees: env["COLLECTIONS_STUB_REFUSE"].split(",").map((p) => p.trim()).filter(Boolean) } : {};
    const stub = new StubChargeRail(store, { ...(options.now ? { clock: options.now } : {}), ...killAfterDispatch, ...fixture, ...refuse, ...(options.stubRail ?? {}) });
    rail = stub;
    pollIntervalMs = 0;
    payer = {
      kind: "stub",
      async pay(_chargeId, attemptId) {
        stub.decide(attemptId, "pays");
        return { ok: true, detail: "stub payer: will pay at the next look" };
      },
      behave: (b) => stub.setPayer(b),
    };
  }

  const runId = options.runId ?? newRunId(mode);
  const bundle = new ProofBundle(runs, runId);
  bundle.mandateSnapshot(mandate);
  bundle.meta({ run_id: runId, agent: `${manifest.manifest.name}@${manifest.manifest.version}`, mode, rail: railKind, mandate_id: mandate.id, started_at: (options.now ?? (() => new Date()))().toISOString() });

  const engine = new ExecutionEngine({
    store,
    rail,
    status: gate,
    signer,
    manifest: manifest.manifest,
    guardrails: { ...guardrails, approval: mode },
    mandate,
    bundle,
    mode,
    runId,
    onBehalfOf: mandate.consumer_id,
    policyExtension: envelopePolicy(envelope),
    ...(options.now ? { clock: options.now } : {}),
  });

  const handlers = makeHandlers(envelope);

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
    envelope,
    store,
    gate,
    rail,
    railKind,
    api,
    payer,
    status: gate,
    bundle,
    runId,
    engine,
    system,
    handlers,
    tools,
    pollIntervalMs,
    makeRuntime,
    makeLoop: (runtime, onExecution) => new AgentLoop({ runtime, tools, handlers, system, bundle, engine, onExecution, ...(options.now ? { clock: options.now } : {}) }),
    close: () => store.close(),
  };
}
