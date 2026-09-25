/**
 * The seam between the shared runner and one agent. Everything the runner
 * cannot know — which rail the agent drives, what the person at the keyboard
 * is called, which tools the model may reach, what a one-shot prints as JSON —
 * comes from the `kit` the agent exports; everything else is here and is the
 * same for every agent.
 *
 * An agent that needs none of it ships no kit at all: `defaultKit` drives the
 * stub payment rail with the example mandate, which is what a read-only agent
 * wants.
 */
import type {
  ChargeInstrument,
  Execution,
  LoadedManifest,
  LocalMandateStatusStub,
  Guardrails,
  Mandate,
  MandateStatusSource,
  PaymentRail,
  PolicyExtension,
  StateStore,
  StubPayerBehaviour,
  StubRailOptions,
  StubChargeRailOptions,
  ToolHandler,
} from "@codespar/agent-core";
import type { ApiClient } from "@codespar/sdk";
import type { Setup } from "./setup.js";
import type { ScenarioCheck } from "./scenarios.js";
import type { AdversarialResult } from "./adversarial.js";

export type RailKind = "stub" | "api";

/**
 * How an execution reaches a terminal state. `immediate`: the rail answers
 * and the execution is settled or failed (money out). `await-payer`: the rail
 * accepts and somebody else has to act, so the run looks at the receivable
 * until it closes (money in).
 */
export type Settlement = "immediate" | "await-payer";

/**
 * Who plays the counterparty in the sandbox. With the stub rail it is the
 * fixture inside the rail; with a test key it is the API's own test route.
 */
export interface SandboxPayer {
  kind: RailKind;
  /** Pays a receivable this run issued. Returns what the payer reported, or the refusal. */
  pay(chargeId: string, attemptId: string): Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** Stub only: what the fixture does with receivables issued from now on. */
  behave(behaviour: StubPayerBehaviour): void;
  /**
   * Stub only: what the fixture does with ONE receivable that was already
   * issued and looked at.
   *
   * It is separate from `behave` because they answer different questions, and
   * a poll needs the second one. `behave` sets the default for receivables
   * the rail has not seen yet; by the time a poll resumes a conversation the
   * rail HAS seen this one, and its fate is a row in state.db that only this
   * rewrites. It is separate from `pay` because `pay` means pay — the
   * scenario runner's late payer calls it after telling the fixture to sit on
   * everything, and it has to pay anyway.
   *
   * The API's payer is a route and has no equivalent, so this is optional.
   */
  decideFor?(attemptId: string, behaviour: StubPayerBehaviour): void;
}

export interface RailContext {
  kind: RailKind;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  stateDir: string;
  manifest: LoadedManifest;
  store: StateStore;
  gate: LocalMandateStatusStub;
  now: (() => Date) | undefined;
  /** The mandate a caller pinned (a scenario, a test), if any. */
  mandate: Mandate | undefined;
  /** Stub-rail overrides a caller pinned (rerun, a scenario). */
  stubRail: StubRailOptions | StubChargeRailOptions | undefined;
  /** Reads `<PREFIX>_<NAME>` from the environment, the prefix being the agent's own. */
  envVar(name: string): string | undefined;
}

export interface RailBuild {
  rail: PaymentRail;
  mandate: Mandate;
  /** The section 4.7 source. Defaults to the local stub gate. */
  status?: MandateStatusSource;
  api?: ApiClient | undefined;
  payer?: SandboxPayer;
  /** Milliseconds between two looks at an issued receivable. */
  pollIntervalMs?: number;
}

export interface RuntimeLabels {
  /** Who decides when no `--user` is given: `usr_terminal`, `usr_operator`. */
  defaultUser: string;
  /** Who decides inside a scenario or an adversarial case. */
  evalUser: string;
  /** The word for the signed instrument in the banner: `mandato`, `politica`. */
  mandateWord: string;
  /** The word for a sealed outcome in the console: `recibo`, `registro`. */
  receiptWord: string;
  /** What the interactive loop prints under the banner. */
  intro: string;
  /** The interactive prompt. */
  prompt: string;
  /** The question an `awaiting_approval` execution asks at the keyboard. */
  approveQuestion: string;
  /** What the console says when a dispatch ended with an unknown outcome. */
  uncertainDispatch: string;
  /** `reconcile`'s finding kind and detail for a sealed outcome the bundle does not hold. */
  missingReceiptKind: string;
  missingReceiptDetail(receiptId: string, runId: string): string;
  /** `resume`'s line for an execution it could not close. */
  stillExecuting(execution: Execution): string;
  /** `await-payer` only: the line printed every few looks while the payer has not acted. */
  waitingForPayer?(round: number): string;
}

export interface OneShotContext {
  setup: Setup;
  reply: string;
  toolCalls: Array<{ name: string; refused: boolean }>;
  executions: Execution[];
  /** `Date.now()` when the turn started, for an agent that reports its cycle. */
  startedAt: number;
}

export interface ConsentContext {
  agentDir: string;
  argv: string[];
  say(line: string): void;
}

export interface EnsureMandateContext extends ConsentContext {
  railKind: RailKind;
  /** True when the run has no conversation to fall back on (a one-shot). */
  oneShot: boolean;
  ask(question: string): Promise<string>;
}

export interface AgentKit {
  /** `immediate` (money out) or `await-payer` (money in). Default `immediate`. */
  settlement?: Settlement;
  /**
   * Which rail a `--scenario` run uses: the stub always, or the one the
   * environment resolved. An agent whose packs declare `rails` wants
   * `requested`; one whose packs are offline fixtures wants `stub`.
   */
  scenarioRail?: "stub" | "requested";
  labels: RuntimeLabels;
  /** The usage text `--help`, a bad flag and a bad `--now` print. */
  usage(manifest: LoadedManifest): string;
  buildRail(ctx: RailContext): RailBuild;
  handlers(setup: Setup): Record<string, ToolHandler>;
  /** The deterministic policy the core runs as its `policyExtension`. */
  policyExtension?(ctx: { agentDir: string; manifest: LoadedManifest; guardrails: Guardrails }): PolicyExtension | undefined;
  /** The console lines that describe one execution. */
  describeExecution(execution: Execution, setup: Setup): string[];
  /** The `--json` body of a one-shot. */
  oneShotPayload(ctx: OneShotContext): Record<string, unknown>;
  /** `await-payer` only: what the payer reads when a receivable becomes payable. */
  presentInstrument?(execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, tell: (line: string) => void): void;
  /** `await-payer` only: the one message per outcome the counterparty receives. */
  announceOutcome?(execution: Execution, setup: Setup, tell: (line: string) => void): boolean;
  /**
   * The SAME outcome as `announceOutcome`, carried as an approved template.
   *
   * It exists because a channel can have a rule about WHEN free text may be
   * sent, and WhatsApp does: outside the 24 hours after the person's last
   * message only a template Meta approved goes out. A collection reaches that
   * state as its normal case — agreed Tuesday, paid Friday — so an agent that
   * closes its cycle on a channel owns a template for each outcome it can
   * close on, or it cannot tell the person at all.
   *
   * The name must be one the agent declares in
   * `channels/whatsapp/templates.json`; the language is the registry's and is
   * not repeated here. `undefined` means this agent has no approved copy for
   * that outcome, which the caller REPORTS rather than papers over: a person
   * who was not told was not told.
   */
  outcomeTemplate?(execution: Execution): { template: string; variables: string[] } | undefined;
  /** Runs before a one-shot or an interactive session, when the mandate may have to be born first. Returns false to stop the run. */
  ensureMandate?(ctx: EnsureMandateContext): Promise<boolean>;
  /** `codespar-agent consent`. Absent means the agent has no consent step. */
  consent?(ctx: ConsentContext): Promise<number>;
  /** The prior settled executions an adversarial case asks for, so a velocity window has history. */
  warmUp?(setup: Setup, aliases: string[], approver: { id: string; channel: string }): Promise<Set<string>>;
  /** The `kind: events` adversarial case: duplicated and out-of-order deliveries. */
  runEventsCase?(setup: Setup, tell: (line: string) => void): Promise<void>;
  /**
   * What a `rerun` has to reproduce from the recorded events, beyond the
   * model's own outputs: a payee the rail refused, a receivable the payer let
   * expire. The rail's and the counterparty's answers are part of the recording.
   */
  rerunPlan?(events: Array<Record<string, unknown>>): { stubRail?: StubRailOptions | StubChargeRailOptions; simulatePayer?: boolean };
  /** Whether `rerun` compares the rail's outcomes as well as the state trail. */
  rerunComparesOutcomes?: boolean;
  /** The one line `eval` prints per scenario run and per adversarial case. */
  evalScenarioLine?(check: ScenarioCheck): string;
  evalAdversarialLine?(result: AdversarialResult): string;
}
