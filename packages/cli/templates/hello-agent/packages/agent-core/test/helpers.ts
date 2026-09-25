import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hmacSigner } from "../src/approval.js";
import { ProofBundle } from "../src/bundle.js";
import { ExecutionEngine, type EngineDeps } from "../src/engine.js";
import { GuardrailsSchema, type Guardrails } from "../src/guardrails.js";
import { MandateSchema, type Mandate } from "../src/mandate.js";
import { ManifestSchema, type Manifest } from "../src/manifest.js";
import { StateStore } from "../src/state/store.js";
import { LocalMandateStatusStub } from "../src/stubs/mandate-status.js";
import type { MandateStatusSource } from "../src/revocation.js";
import { StubRail, type StubRailOptions } from "../src/stubs/rail.js";
import type { ApprovalMode } from "../src/types.js";

export const ESCOLA = "escola@exemplo.com.br";
export const MERCADO = "+5511999990001";
export const FUNCIONARIA = "123.456.789-09";

export function testManifest(over: Partial<Manifest> = {}): Manifest {
  return ManifestSchema.parse({
    schema: 1,
    name: "bills-agent",
    version: "0.1.0",
    approval: ["human", "mandate"],
    default_approval: "human",
    escalate_above: { amount: 150000, new_beneficiary: true, outside_hours: "22:00-07:00" },
    mcp: "@codespar/mcp@0.5.8",
    cli: "@codespar/cli@0.14.0",
    tools: "./tools.json",
    guardrails: "./guardrails.json",
    mandate_schema: "./mandate.example.json",
    events: ["commerce.payment.succeeded", "commerce.payment.failed"],
    channels: ["terminal"],
    maturity: { "pix-out": "sandbox", "embedded-consent": "sandbox", "receipt-verification": "blocked" },
    scenarios: "./scenarios/",
    evals: "./evals/",
    agents_md: "./AGENTS.md",
    ...over,
  });
}

export function testGuardrails(over: Partial<Guardrails> = {}): Guardrails {
  return GuardrailsSchema.parse({
    approval: "human",
    escalate_above: { amount: 150000, new_beneficiary: true, outside_hours: "22:00-07:00" },
    velocity: { window_hours: 24 },
    ...over,
  });
}

export function testMandate(over: Partial<Mandate> = {}): Mandate {
  return MandateSchema.parse({
    id: "mdt_test_0001",
    version: 1,
    consumer_id: "usr_demo",
    agent_id: "bills-agent",
    purpose: "contas do mes",
    currency: "BRL",
    cap_minor: 7200000,
    per_tx_cap_minor: 250000,
    periodic_cap: { window: "month", cap_minor: 600000 },
    merchant_pin_kind: "pix-key",
    merchant_allowlist: [ESCOLA, MERCADO, FUNCIONARIA],
    beneficiaries: [
      { alias: "escola", name: "Escola Aurora", payee: ESCOLA },
      { alias: "mercado", name: "Mercado do Bairro", payee: MERCADO },
      { alias: "funcionaria", name: "Maria (funcionaria)", payee: FUNCIONARIA },
    ],
    status: "active",
    expires_at: "2027-09-23T00:00:00.000Z",
    ...over,
  });
}

export interface Harness {
  dir: string;
  store: StateStore;
  gate: LocalMandateStatusStub;
  rail: StubRail;
  bundle: ProofBundle;
  engine: ExecutionEngine;
  now: Date;
  setNow(date: Date): void;
}

export interface HarnessOptions {
  mode?: ApprovalMode;
  now?: Date;
  guardrails?: Partial<Guardrails>;
  mandate?: Partial<Mandate>;
  manifest?: Partial<Manifest>;
  rail?: StubRailOptions;
  dir?: string;
  runId?: string;
  /** The section 4.7 status source; the local stub unless a test wires the API one. */
  status?: MandateStatusSource;
}

export function harness(options: HarnessOptions = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "agent-core-"));
  let now = options.now ?? new Date("2026-09-23T18:00:00Z"); // 15:00 in Sao Paulo
  const clock = () => now;
  const store = new StateStore(join(dir, "state.db"));
  const gate = new LocalMandateStatusStub(store, clock);
  const rail = new StubRail(store, { clock, ...(options.rail ?? {}) });
  const runId = options.runId ?? "run_test";
  const bundle = new ProofBundle(join(dir, "runs"), runId);
  const mode = options.mode ?? "human";
  const deps: EngineDeps = {
    store,
    rail,
    status: options.status ?? gate,
    signer: hmacSigner("test", Buffer.alloc(32, 1)),
    manifest: testManifest(options.manifest),
    guardrails: testGuardrails({ approval: mode, ...(options.guardrails ?? {}) }),
    mandate: testMandate(options.mandate),
    bundle,
    mode,
    runId,
    onBehalfOf: "usr_demo",
    clock,
  };
  const engine = new ExecutionEngine(deps);
  return {
    dir,
    store,
    gate,
    rail,
    bundle,
    engine,
    get now() {
      return now;
    },
    setNow(date: Date) {
      now = date;
    },
  };
}
