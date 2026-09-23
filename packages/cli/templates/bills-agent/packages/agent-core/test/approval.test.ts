import { describe, expect, it } from "vitest";
import { checkApprovalArtifact, createApprovalArtifact, hmacSigner } from "../src/approval.js";
import { itemsHash } from "../src/hash.js";
import type { Execution } from "../src/state-machine.js";
import type { Actor, ExecutionItem } from "../src/types.js";

const actor: Actor = { type: "human", id: "usr_1", channel: "terminal" };
const signer = hmacSigner("test", Buffer.alloc(32, 7));
const now = new Date("2026-09-23T14:03:11Z");

function execution(items: ExecutionItem[]): Execution<"awaiting_approval"> {
  return {
    id: "exe_1",
    run_id: "run_1",
    state: "awaiting_approval",
    mode: "human",
    actor: { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_1" },
    items,
    total: items.reduce((s, i) => s + i.amount, 0),
    currency: "BRL",
    items_hash: itemsHash(items),
    mandate: { id: "mdt_1", version: 3 },
    idempotency_key: "idk_1",
    blocking_reasons: [],
    outcomes: [],
    history: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

const escola: ExecutionItem = { alias: "escola", beneficiary: "Escola", payee: "escola@exemplo.com.br", amount: 185000, currency: "BRL" };

describe("section 4.2: approval artifact", () => {
  it("has the schema of the spec and an HMAC signature that verifies", () => {
    const exe = execution([escola]);
    const artifact = createApprovalArtifact(signer, { execution: exe, approver: { type: "person", id: "usr_1", channel: "terminal" }, actor, now });
    expect(artifact.approval_id).toMatch(/^apr_/);
    expect(artifact.execution_id).toBe("exe_1");
    expect(artifact.mode).toBe("human");
    expect(artifact.mandate).toEqual({ id: "mdt_1", version: 3 });
    expect(artifact.items_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.signature.alg).toBe("HMAC-SHA256");
    expect(artifact.actor).toEqual(actor);
    expect(new Date(artifact.expires_at).getTime() - new Date(artifact.approved_at).getTime()).toBe(15 * 60 * 1000);
    expect(checkApprovalArtifact(signer, artifact, exe, now)).toEqual({ ok: true });
  });

  it("items_hash ignores presentation fields and changes when the money fields change", () => {
    const base = itemsHash([escola]);
    expect(itemsHash([{ ...escola, description: "outubro", beneficiary: "Escola X" }])).toBe(base);
    expect(itemsHash([{ ...escola, amount: 185001 }])).not.toBe(base);
    expect(itemsHash([{ ...escola, payee: "outra@chave" }])).not.toBe(base);
  });

  it("refuses when the list changed after approval (items_hash mismatch)", () => {
    const exe = execution([escola]);
    const artifact = createApprovalArtifact(signer, { execution: exe, approver: { type: "person", id: "usr_1", channel: "terminal" }, actor, now });
    const tampered = { ...exe, items: [{ ...escola, amount: 500000 }] };
    expect(checkApprovalArtifact(signer, artifact, tampered, now)).toEqual({ ok: false, problem: "items_hash_mismatch" });
  });

  it("refuses a tampered artifact, an expired one and a foreign key", () => {
    const exe = execution([escola]);
    const artifact = createApprovalArtifact(signer, { execution: exe, approver: { type: "person", id: "usr_1", channel: "terminal" }, actor, now });
    expect(checkApprovalArtifact(signer, { ...artifact, items_hash: itemsHash([{ ...escola, amount: 1 }]) }, exe, now)).toEqual({ ok: false, problem: "signature_invalid" });
    expect(checkApprovalArtifact(signer, artifact, exe, new Date(now.getTime() + 16 * 60 * 1000))).toEqual({ ok: false, problem: "expired" });
    expect(checkApprovalArtifact(hmacSigner("other", Buffer.alloc(32, 9)), artifact, exe, now)).toEqual({ ok: false, problem: "signature_invalid" });
    expect(checkApprovalArtifact(signer, artifact, { ...exe, mandate: { id: "mdt_1", version: 4 } }, now)).toEqual({ ok: false, problem: "wrong_mandate" });
  });

  it("records the escalation trigger when there was one", () => {
    const exe = execution([escola]);
    const artifact = createApprovalArtifact(signer, {
      execution: exe,
      approver: { type: "person", id: "usr_1", channel: "terminal" },
      actor,
      now,
      escalation: { trigger: "amount", detail: "above 150000" },
    });
    expect(artifact.escalation).toEqual({ trigger: "amount", detail: "above 150000" });
  });
});
