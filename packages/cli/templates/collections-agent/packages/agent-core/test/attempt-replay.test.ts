/**
 * What a repeated `attempt_id` answers on the deployed API (ent#1671,
 * codespar-enterprise #1683), and what the kit reads each answer as. The
 * CodeSpar rail is driven through the real SDK client against a mocked HTTP
 * server, so the error envelope is parsed the way it is in production; the
 * stub rail is held to the same table, because a stub that answered a repeat
 * more kindly than the API would let a suite pass that the API fails.
 */
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { CodeSparRail } from "../src/api/rail.js";
import { batchAttemptId } from "../src/hash.js";
import { quoteFromApproval } from "../src/quote.js";
import type { PaymentRail, RailOutcome, RailPayment } from "../src/rail.js";
import { StubRail } from "../src/stubs/rail.js";
import { StateStore } from "../src/state/store.js";
import { ESCOLA, harness, MERCADO } from "./helpers.js";

const actor = { type: "agent" as const, agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" };

function payment(over: Partial<RailPayment> = {}): RailPayment {
  return {
    attempt_id: "ska_replay_0",
    mandate_id: "mdt_test_0001",
    amount_minor: 185000,
    currency: "BRL",
    payee: ESCOLA,
    purpose: "contas do mes",
    agent_id: "bills-agent",
    quote: { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA },
    approval: { items_hash: `sha256:${"1".repeat(64)}` },
    actor,
    ...over,
  };
}

type Answer = { status: number; body: unknown };

let server: Server;
let baseUrl: string;
let answer: Answer;
let posts = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") posts += 1;
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  posts = 0;
});

function rail(): CodeSparRail {
  // The placeholder passes the `csk_test_` guard and is the one test-key-shaped string the secret scan allows.
  return new CodeSparRail(createCodeSparClient({ apiKey: "csk_test_your_key_here", baseUrl, timeoutMs: 5_000 }));
}

function refusal(code: string, details?: Record<string, unknown>): Answer {
  return { status: 409, body: { error: { code, message: `api: ${code}`, ...(details ? { details } : {}) }, request_id: null } };
}

/** The ORIGINAL settled body, as the API stores it and answers it again with `idempotent_replay: true`. */
const settledBody = {
  payment: { transactionId: "tx_original", moneyMoved: false },
  receipt: { id: "rcpt_original" },
};

describe("CodeSparRail reads every answer to a repeated attempt_id (ent#1671)", () => {
  it("settled: the original body with idempotent_replay is the original outcome, same transaction and same receipt, marked replayed", async () => {
    answer = { status: 200, body: { ...settledBody, idempotent_replay: true } };
    for (const outcome of [await rail().pay(payment()), await rail().lookup("ska_replay_0", payment())]) {
      expect(outcome).toMatchObject({ status: "settled", transaction_id: "tx_original", receipt_id: "rcpt_original", replayed: true });
    }
  });

  it("the call that settles it is not a replay", async () => {
    answer = { status: 200, body: { ...settledBody, idempotent_replay: false } };
    const outcome = await rail().pay(payment());
    expect(outcome).toMatchObject({ status: "settled" });
    expect("replayed" in outcome).toBe(false);
  });

  it("psp_attempt_in_flight: never a refusal. pay() reads it as unknown, lookup() as still running", async () => {
    answer = refusal("psp_attempt_in_flight");
    expect(await rail().pay(payment())).toMatchObject({ status: "uncertain", code: "psp_attempt_in_flight" });
    expect(await rail().lookup("ska_replay_0", payment())).toEqual({ status: "in_flight" });
  });

  it("psp_attempt_uncertain: pinned for reconciliation, on both paths", async () => {
    answer = refusal("psp_attempt_uncertain");
    expect(await rail().pay(payment())).toMatchObject({ status: "uncertain", code: "psp_attempt_uncertain" });
    expect(await rail().lookup("ska_replay_0", payment())).toMatchObject({ status: "uncertain", code: "psp_attempt_uncertain" });
  });

  it("psp_attempt_conflict: failed with no money, and the id is spent", async () => {
    answer = refusal("psp_attempt_conflict");
    expect(await rail().pay(payment())).toEqual({ status: "failed", code: "psp_attempt_conflict", message: "api: psp_attempt_conflict", spent: true });
    expect(await rail().lookup("ska_replay_0", payment())).toMatchObject({ status: "failed", spent: true });
  });

  it("attempt_id_conflict and attempt_id_unavailable: a refusal that sent nothing, held for another payment or project, and NEVER spent", async () => {
    for (const [code, details, held] of [
      ["attempt_id_conflict", { mismatched_fields: ["quote"], attempt_id: "ska_replay_0" }, "conflict"],
      ["attempt_id_unavailable", { attempt_id: "ska_replay_0" }, "unavailable"],
    ] as const) {
      answer = refusal(code, details);
      for (const outcome of [await rail().pay(payment()), await rail().lookup("ska_replay_0", payment())]) {
        expect(outcome).toEqual({ status: "failed", code, message: `api: ${code}`, held });
      }
    }
  });

  it("every answer above is one POST: a lookup is the same presentation, never a second call of its own", async () => {
    answer = refusal("psp_attempt_in_flight");
    await rail().lookup("ska_replay_0", payment());
    expect(posts).toBe(1);
  });
});

describe("the stub rail answers a repeat the way the API does", () => {
  function stub(options: ConstructorParameters<typeof StubRail>[1] = {}): StubRail {
    return new StubRail(new StateStore(join(mkdtempSync(join(tmpdir(), "agent-core-replay-")), "state.db")), options);
  }

  it("settled: the original outcome, marked replayed, and nothing paid again", async () => {
    const r = stub();
    const first = await r.pay(payment());
    const again = await r.pay(payment());
    expect(r.payCount).toBe(1);
    expect(again).toMatchObject({ status: "settled", replayed: true, transaction_id: (first as { transaction_id: string }).transaction_id, receipt_id: (first as { receipt_id: string }).receipt_id });
    expect("replayed" in first).toBe(false);
    expect((again as { raw: Record<string, unknown> }).raw["idempotent_replay"]).toBe(true);
  });

  it("a different payment under the same id is attempt_id_conflict, whatever became of the first, and names what differs", async () => {
    const r = stub();
    await r.pay(payment());
    const changed = await r.pay(payment({ quote: { ...payment().quote!, at: "2026-09-23T18:00:00.000Z" } }));
    expect(changed).toMatchObject({ status: "failed", code: "attempt_id_conflict", held: "conflict" });
    expect((changed as { message: string }).message).toContain("quote");
    expect((changed as { spent?: true }).spent).toBeUndefined();
    const otherPayee = await r.pay(payment({ payee: MERCADO, quote: { ...payment().quote!, payee: MERCADO } }));
    expect((otherPayee as { message: string }).message).toContain("payee");
    expect(r.payCount).toBe(1);
  });

  it("failed: psp_attempt_conflict, spent", async () => {
    const r = stub({ refusePayees: [ESCOLA] });
    expect(await r.pay(payment())).toMatchObject({ status: "failed", code: "psp_dispatch_failed" });
    expect(await r.pay(payment())).toMatchObject({ status: "failed", code: "psp_attempt_conflict", spent: true });
    expect(r.payCount).toBe(1);
  });

  it("in flight: psp_attempt_in_flight on another presentation, on the shared books another machine reads too", async () => {
    const ledger = new StateStore(join(mkdtempSync(join(tmpdir(), "agent-core-ledger-")), "rail.db"));
    const a = stub({ ledger, uncertainPayees: [ESCOLA] });
    expect(await a.pay(payment())).toMatchObject({ status: "uncertain", code: "psp_dispatch_uncertain" });
    const b = stub({ ledger });
    expect(await b.pay(payment())).toMatchObject({ status: "uncertain", code: "psp_attempt_in_flight" });
    expect(b.payCount).toBe(0);
    expect(await b.lookup("ska_replay_0", payment())).toEqual({ status: "in_flight" });
    expect(await b.lookup("ska_replay_0", payment())).toMatchObject({ status: "settled" });
    expect(b.payCount).toBe(0);
  });
});

describe("a batch line's quote is the same on every run of the list", () => {
  it("stable leaves the approval time out; anything else keeps it", () => {
    const artifact = { approved_at: "2026-09-23T18:00:00.000Z", items: [{ beneficiary: "Escola Aurora", description: "outubro", amount: 185000, payee: ESCOLA }] } as never;
    expect(quoteFromApproval(artifact, 0, "contas do mes")).toEqual({ seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA, at: "2026-09-23T18:00:00.000Z" });
    expect(quoteFromApproval(artifact, 0, "contas do mes", { stable: true })).toEqual({ seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: ESCOLA });
  });
});

/**
 * When a batch line moves to the next generation of its id: on
 * `psp_attempt_conflict` — the server stating the attempt failed with no
 * money — and on NOTHING else. Advancing on an unknown outcome is how one line
 * gets paid under two ids; advancing on `attempt_id_conflict` or
 * `attempt_id_unavailable` is minting a new payment for an id somebody else's
 * record holds.
 */
describe("a batch line's attempt id advances on a spent id, and on nothing else", () => {
  const BATCH = { ref: "folha-teste", batch_hash: `sha256:${"a".repeat(64)}`, index: 0, count: 1 };
  const approver = { id: "usr_demo", channel: "terminal" };

  /** A rail that answers `script(n)` for its n-th call, and records every attempt id it was shown. */
  function scripted(script: (call: number) => RailOutcome) {
    const seen: string[] = [];
    const wrap = (): PaymentRail => ({
      name: "stub",
      pay: async (p) => (seen.push(p.attempt_id), script(seen.length - 1)),
      lookup: async () => undefined,
      receipt: async () => undefined,
    });
    return { seen, wrap };
  }

  async function runLine(rail: ReturnType<typeof scripted>) {
    const h = harness({ wrapRail: rail.wrap });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }], batch: BATCH });
    if (!d.ok) throw new Error(`refused before draft: ${d.reason}`);
    h.engine.approve(d.execution.id, approver);
    return h.engine.execute(d.execution.id);
  }

  const held: Array<[string, RailOutcome]> = [
    ["attempt_id_conflict", { status: "failed", code: "attempt_id_conflict", message: "used for a different payment", held: "conflict" }],
    ["attempt_id_unavailable", { status: "failed", code: "attempt_id_unavailable", message: "not available", held: "unavailable" }],
    ["an unknown refusal", { status: "failed", code: "some_code_nobody_documented", message: "?" }],
    ["psp_attempt_in_flight", { status: "uncertain", code: "psp_attempt_in_flight", message: "claimed" }],
    ["psp_attempt_uncertain", { status: "uncertain", code: "psp_attempt_uncertain", message: "pinned" }],
    ["psp_dispatch_uncertain", { status: "uncertain", code: "psp_dispatch_uncertain", message: "timeout" }],
  ];
  for (const [name, answer] of held) {
    it(`${name}: one presentation, the generation-0 id, no generation recorded`, async () => {
      const rail = scripted(() => answer);
      const out = await runLine(rail);
      const g0 = batchAttemptId(out.mandate.id, BATCH, 0);
      expect(rail.seen).toEqual([g0]);
      expect(out.attempt_generations).toBeUndefined();
      expect(out.state).toBe(answer.status === "failed" ? "failed" : "executing");
    });
  }

  it("psp_attempt_conflict: the next generation, derived the same way on any machine, and saved on the execution", async () => {
    const settled: RailOutcome = { status: "settled", transaction_id: "tx_g2", receipt_id: null, money_moved: false, sandbox: true, raw: {} };
    const spent: RailOutcome = { status: "failed", code: "psp_attempt_conflict", message: "failed, no money", spent: true };
    const rail = scripted((call) => (call < 2 ? spent : settled));
    const out = await runLine(rail);
    expect(rail.seen).toEqual([0, 1, 2].map((g) => batchAttemptId(out.mandate.id, BATCH, 0, g)));
    expect(out.state).toBe("settled");
    expect(out.outcomes[0]!.attempt_id).toBe(rail.seen[2]);
    expect(out.attempt_generations).toEqual({ 0: 2 });
  });

  it("a psp_attempt_conflict the rail did not mark spent does not advance either", async () => {
    const rail = scripted(() => ({ status: "failed", code: "psp_attempt_conflict", message: "no spent flag" }));
    const out = await runLine(rail);
    expect(rail.seen).toHaveLength(1);
    expect(out.attempt_generations).toBeUndefined();
  });

  it("stops after eight spent generations, failed, never looping", async () => {
    const rail = scripted(() => ({ status: "failed", code: "psp_attempt_conflict", message: "failed, no money", spent: true }));
    const out = await runLine(rail);
    expect(rail.seen).toHaveLength(9);
    expect(out.state).toBe("failed");
    expect(out.attempt_generations).toEqual({ 0: 8 });
  });
});
