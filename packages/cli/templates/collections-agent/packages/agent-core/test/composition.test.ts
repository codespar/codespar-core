import { describe, expect, it, vi } from "vitest";

// Deterministic ids, so an artifact is the same bytes on every run and its hash can be pinned.
vi.mock("../src/ids.js", async (original) => {
  const real = await original<typeof import("../src/ids.js")>();
  let n = 0;
  return { ...real, newId: (prefix: string) => `${prefix}_${String((n += 1)).padStart(16, "0")}` };
});

import { checkApprovalArtifact, createApprovalArtifact, hmacSigner } from "../src/approval.js";
import { canonicalJson, compositionHash, itemsHash, sha256Hex } from "../src/hash.js";
import type { Execution } from "../src/state-machine.js";
import { ToolsFileSchema } from "../src/tools.js";
import type { CompositionLine, ExecutionComposition, ExecutionItem } from "../src/types.js";
import { harness } from "./helpers.js";

const signer = hmacSigner("local-dev-stub", Buffer.alloc(32, 1));
const now = new Date("2026-09-23T18:00:00.000Z");
const person = { type: "person" as const, id: "usr_terminal", channel: "terminal" };
const human = { type: "human" as const, id: "usr_terminal", channel: "terminal" };
const approver = { id: "usr_terminal", channel: "terminal" };

function execution(items: ExecutionItem[], over: Partial<Execution> = {}): Execution {
  return {
    id: "exe_1",
    run_id: "run_1",
    state: "awaiting_approval",
    mode: "human",
    actor: { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" },
    items,
    total: items.reduce((s, i) => s + i.amount, 0),
    currency: "BRL",
    items_hash: itemsHash(items),
    mandate: { id: "mdt_test_0001", version: 1 },
    idempotency_key: "idk_1",
    blocking_reasons: [],
    outcomes: [],
    history: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...over,
  } as Execution;
}

const escola: ExecutionItem = { alias: "escola", beneficiary: "Escola Aurora", payee: "escola@exemplo.com.br", amount: 185000, currency: "BRL", description: "outubro" };

const line = (ref: string, quantity: number, unit_amount: number, amount = quantity * unit_amount): CompositionLine => ({ ref, quantity, unit_amount, amount, currency: "BRL" });
const twoLessons = [line("aula-avulsa", 2, 10000)];
const oneConsulting = [line("consultoria-1h", 1, 20000)];
const composition = (ref: string, lines: CompositionLine[]): ExecutionComposition => ({ ref, composition_hash: compositionHash(lines), line_count: lines.length });

describe("dependency 9.7: an artifact without a composition is the artifact it was before, byte for byte", () => {
  it("hashes to what the same artifact hashed to on main before `composition` existed", () => {
    // The bills-agent's shape: one payee, no batch, no composition. The two
    // constants were computed on origin/main at 768c1a2, before this change,
    // with the same ids, key, clock and execution. If `composition` were
    // written as null — or any key added — both would move.
    const artifact = createApprovalArtifact(signer, { execution: execution([escola]), approver: person, actor: human, now });
    expect("composition" in artifact).toBe(false);
    expect(sha256Hex(canonicalJson(artifact))).toBe("3c7da9ead8078c58e6727dc6645ff1cde3f7e69d78502ea17350887ba201f030");
    expect(artifact.signature.value).toBe("5fd40687454f7a67a84cb6bb375eb91b7d9ba3d20242d1fe95c7845c9dc31a0a");
  });
});

describe("dependency 9.7: the composition is carried, signed and compared", () => {
  it("an artifact carries the composition of the execution it approves, and the signature covers it", () => {
    const order: ExecutionItem = { beneficiary: "Marina Costa", payee: "11144477735", amount: 20000, currency: "BRL", due_date: "2026-09-23" };
    const exe = execution([order], { composition: composition("cart-1", twoLessons) });
    const artifact = createApprovalArtifact(signer, { execution: exe, approver: person, actor: human, now });
    expect(artifact.composition).toEqual(exe.composition);
    expect(checkApprovalArtifact(signer, artifact, exe, now)).toEqual({ ok: true });
    for (const changed of [composition("cart-1", oneConsulting), { ...exe.composition!, ref: "cart-2" }, { ...exe.composition!, line_count: 2 }]) {
      expect(checkApprovalArtifact(signer, { ...artifact, composition: changed }, exe, now)).toEqual({ ok: false, problem: "signature_invalid" });
      expect(checkApprovalArtifact(signer, artifact, { ...exe, composition: changed }, now)).toEqual({ ok: false, problem: "composition_mismatch" });
    }
  });

  it("the case items_hash cannot see: the same total, another cart", () => {
    const order: ExecutionItem = { beneficiary: "Marina Costa", payee: "11144477735", amount: 20000, currency: "BRL", due_date: "2026-09-23" };
    const approved = execution([order], { composition: composition("cart-1", twoLessons) });
    const artifact = createApprovalArtifact(signer, { execution: approved, approver: person, actor: human, now });
    const recomposed = { ...approved, composition: composition("cart-1", oneConsulting) };
    expect(recomposed.items_hash).toBe(artifact.items_hash);
    expect(checkApprovalArtifact(signer, artifact, recomposed, now)).toEqual({ ok: false, problem: "composition_mismatch" });
  });

  it("gaining or losing a composition after approval is a different execution", () => {
    const order: ExecutionItem = { beneficiary: "Marina Costa", payee: "11144477735", amount: 20000, currency: "BRL" };
    const bare = execution([order]);
    const bareArtifact = createApprovalArtifact(signer, { execution: bare, approver: person, actor: human, now });
    expect(checkApprovalArtifact(signer, bareArtifact, { ...bare, composition: composition("cart-1", twoLessons) }, now)).toEqual({ ok: false, problem: "composition_mismatch" });
    const composed = execution([order], { composition: composition("cart-1", twoLessons) });
    const composedArtifact = createApprovalArtifact(signer, { execution: composed, approver: person, actor: human, now });
    const { composition: _dropped, ...stripped } = composed;
    expect(checkApprovalArtifact(signer, composedArtifact, stripped as Execution, now)).toEqual({ ok: false, problem: "composition_mismatch" });
  });

  it("the hash sees quantity, unit price and order, which items_hash's fields cannot", () => {
    // Ten at a 10% discount and nine at list price: the same line amount, not the same sale.
    expect(compositionHash([line("aula-avulsa", 10, 10000, 90000)])).not.toBe(compositionHash([line("aula-avulsa", 9, 10000, 90000)]));
    expect(compositionHash([line("aula-avulsa", 10, 9000, 90000)])).not.toBe(compositionHash([line("aula-avulsa", 10, 10000, 90000)]));
    const a = line("aula-avulsa", 1, 10000);
    const b = line("avaliacao-inicial", 1, 8990);
    expect(compositionHash([a, b])).not.toBe(compositionHash([b, a]));
    expect(compositionHash([a, b])).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A discount line is a line: a coupon swapped at a constant total is another composition.
    expect(compositionHash([a, line("coupon:BEMVINDO10", 1, -1000)])).not.toBe(compositionHash([a, line("discount:order", 1, -1000)]));
  });
});

describe("dependency 9.7 in the engine: a cart recomposed after approval goes back to a person", () => {
  const draftOrder = async (h: ReturnType<typeof harness>, lines: CompositionLine[]) => {
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 20000 }], composition: composition("cart-1", lines) });
    if (!d.ok) throw new Error("refused");
    return d.execution;
  };

  it("draft stamps the composition on the execution and on every artifact of it", async () => {
    const h = harness({ mode: "human" });
    const drafted = await draftOrder(h, twoLessons);
    expect(drafted.composition).toEqual(composition("cart-1", twoLessons));
    const approved = h.engine.approve(drafted.id, approver);
    expect(h.store.getApproval(approved.approval_id!)!.composition).toEqual(composition("cart-1", twoLessons));
  });

  it("restated at a constant total: items_hash unchanged, the last gate refuses, a second yes mints a second artifact", async () => {
    const h = harness({ mode: "human" });
    const approved = h.engine.approve((await draftOrder(h, twoLessons)).id, approver);
    const first = approved.approval_id!;
    const restated = h.engine.restate(approved.id, { items: [{ payee: "escola", amount: 20000 }], composition: composition("cart-1", oneConsulting) });
    expect(restated.state).toBe("approved");
    expect(restated.items_hash).toBe(approved.items_hash);
    expect(restated.approval_id).toBe(first);

    const back = await h.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.reason).toBe("items_hash_mismatch");
    expect(back.detail).toContain("composition_mismatch");
    expect(back.approval_id).toBeUndefined();
    expect(h.store.listOutbox()).toHaveLength(0);

    const again = h.engine.approve(back.id, approver);
    expect(again.approval_id).not.toBe(first);
    expect(h.store.getApproval(again.approval_id!)!.composition).toEqual(composition("cart-1", oneConsulting));
    const ran = await h.engine.execute(again.id);
    expect(ran.state).toBe("settled");
    expect(ran.history.map((t) => t.to)).toEqual(["awaiting_approval", "approved", "awaiting_approval", "approved", "executing", "settled"]);
  });

  it("restated with a new total: the new total is the one judged and run", async () => {
    const h = harness({ mode: "human" });
    const approved = h.engine.approve((await draftOrder(h, twoLessons)).id, approver);
    const fiveLessons = [line("aula-avulsa", 5, 10000)];
    h.engine.restate(approved.id, { items: [{ payee: "escola", amount: 50000 }], composition: composition("cart-1", fiveLessons) });
    const back = await h.engine.execute(approved.id);
    expect(back.state).toBe("awaiting_approval");
    expect(back.total).toBe(50000);
    const ran = await h.engine.execute(h.engine.approve(back.id, approver).id);
    expect(ran.state).toBe("settled");
    expect(h.engine.list({ state: "settled" }).map((e) => e.total)).toEqual([50000]);
  });

  it("restate changes what is charged, never to whom, and never an execution that is no longer open", async () => {
    const h = harness({ mode: "human" });
    const drafted = await draftOrder(h, twoLessons);
    expect(() => h.engine.restate(drafted.id, { items: [{ payee: "mercado", amount: 20000 }] })).toThrow(/payees/);
    expect(() => h.engine.restate(drafted.id, { items: [{ payee: "escola", amount: 10000 }, { payee: "escola", amount: 10000 }] })).toThrow(/payees/);
    expect(() => h.engine.restate(drafted.id, { items: [{ payee: "escola", amount: 20000 }], batch: { ref: "b", batch_hash: "sha256:x", index: 0, count: 1 } })).toThrow(/batch/);
    const denied = h.engine.deny(drafted.id, approver);
    expect(() => h.engine.restate(denied.id, { items: [{ payee: "escola", amount: 20000 }] })).toThrow(/only an open execution/);
  });

  it("a composition that cannot be a hash of lines is refused where the execution is minted", async () => {
    const h = harness({ mode: "human" });
    await expect(h.engine.draft({ items: [{ payee: "escola", amount: 20000 }], composition: { ref: "cart-1", composition_hash: "sha256:nope", line_count: 1 } })).rejects.toThrow(/composition_hash/);
    await expect(h.engine.draft({ items: [{ payee: "escola", amount: 20000 }], composition: { ...composition("cart-1", twoLessons), line_count: 0 } })).rejects.toThrow(/line_count/);
    await expect(h.engine.draft({ items: [{ payee: "escola", amount: 20000 }], composition: { ...composition("cart-1", twoLessons), ref: " " } })).rejects.toThrow(/ref/);
  });

  it("an execution without a composition carries no composition key, in state or in the bundle", async () => {
    const h = harness({ mode: "human" });
    const d = await h.engine.draft({ items: [{ payee: "escola", amount: 1000 }] });
    if (!d.ok) throw new Error("refused");
    const approved = h.engine.approve(d.execution.id, approver);
    expect("composition" in approved).toBe(false);
    expect("composition" in h.store.getApproval(approved.approval_id!)!).toBe(false);
    for (const e of h.store.listEvents()) expect(JSON.stringify(e.payload)).not.toContain("composition");
  });
});

describe("dependency 9.8: `state` is an effect, and only a local tool has it", () => {
  const tool = (effect: string) => ({ name: "cart_update", effect, description: "replaces the cart", input_schema: { type: "object" } });
  it("a local tool may change state", () => {
    expect(ToolsFileSchema.safeParse({ meta_tools: [], local_tools: [tool("state")] }).success).toBe(true);
  });
  it("a meta-tool may not: CodeSpar's names are for money and reads", () => {
    const parsed = ToolsFileSchema.safeParse({ meta_tools: [{ ...tool("state"), name: "codespar_cart" }], local_tools: [] });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.message).toContain("a state tool is local");
  });
  it("an effect outside the enum is still refused", () => {
    expect(ToolsFileSchema.safeParse({ meta_tools: [], local_tools: [tool("write")] }).success).toBe(false);
  });
});
