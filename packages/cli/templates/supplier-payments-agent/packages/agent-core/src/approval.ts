/**
 * Section 4.2: the approval artifact.
 *
 * STUB, on purpose: the artifact is signed with a LOCAL development key
 * (`.codespar/approval.key`, generated on first use, never committed). The
 * CodeSpar API does not sign approval lists; its HMAC is the mandate proof
 * and the receipt seal. Until an API-side signature exists the artifact
 * proves what was approved to whoever runs the agent, and to nobody else.
 * See docs/OPEN_QUESTIONS.md.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, hexEqual, hmacSha256Hex, itemsHash } from "./hash.js";
import type { Execution } from "./state-machine.js";
import type { Actor, ApprovalArtifact, EscalationTrigger, ExecutionBatch } from "./types.js";
import { newId } from "./ids.js";

export const APPROVAL_KEY_ID = "local-dev-stub";
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;

export interface ApprovalSigner {
  keyId: string;
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export function loadOrCreateLocalApprovalKey(stateDir: string): ApprovalSigner {
  const path = join(stateDir, "approval.key");
  let key: Buffer;
  if (existsSync(path)) {
    key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  } else {
    mkdirSync(dirname(path), { recursive: true });
    key = randomBytes(32);
    writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return hmacSigner(APPROVAL_KEY_ID, key);
}

export function hmacSigner(keyId: string, key: Buffer): ApprovalSigner {
  return {
    keyId,
    sign: (payload) => hmacSha256Hex(key, payload),
    verify: (payload, signature) => hexEqual(hmacSha256Hex(key, payload), signature),
  };
}

function unsignedPayload(artifact: Omit<ApprovalArtifact, "signature">): string {
  return canonicalJson(artifact);
}

export interface CreateApprovalInput {
  execution: Execution;
  approver: ApprovalArtifact["approver"];
  actor: Actor;
  now: Date;
  ttlMs?: number;
  escalation?: { trigger: EscalationTrigger; detail: string };
}

export function createApprovalArtifact(signer: ApprovalSigner, input: CreateApprovalInput): ApprovalArtifact {
  const { execution } = input;
  const approvedAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString();
  const unsigned: Omit<ApprovalArtifact, "signature"> = {
    approval_id: newId("apr"),
    execution_id: execution.id,
    mode: execution.mode,
    approver: input.approver,
    approved_at: approvedAt,
    expires_at: expiresAt,
    mandate: execution.mandate,
    items: execution.items,
    items_hash: itemsHash(execution.items),
    // The SET this line belongs to, when it belongs to one. Omitted — never
    // null — on an execution that is not part of a batch, so the payload a
    // bills-agent artifact signs is unchanged by this field existing.
    ...(execution.batch ? { batch: execution.batch } : {}),
    ...(input.escalation ? { escalation: input.escalation } : {}),
    actor: input.actor,
  };
  return {
    ...unsigned,
    signature: { alg: "HMAC-SHA256", key_id: signer.keyId, value: signer.sign(unsignedPayload(unsigned)) },
  };
}

export type ApprovalCheck =
  | { ok: true }
  | { ok: false; problem: "signature_invalid" | "items_hash_mismatch" | "expired" | "wrong_execution" | "wrong_mandate" | "batch_mismatch" };

/** Two batch bindings are the same binding, or one is absent and so is the other. */
function sameBatch(a: ExecutionBatch | undefined, b: ExecutionBatch | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.ref === b.ref && a.batch_hash === b.batch_hash && a.index === b.index && a.count === b.count;
}

/**
 * The rule that makes the artifact proof: before `executing`, recompute the
 * hash of what is about to be executed and compare it with the artifact.
 */
export function checkApprovalArtifact(
  signer: ApprovalSigner,
  artifact: ApprovalArtifact,
  execution: Execution,
  now: Date,
): ApprovalCheck {
  const { signature, ...unsigned } = artifact;
  if (!signer.verify(unsignedPayload(unsigned), signature.value)) return { ok: false, problem: "signature_invalid" };
  if (artifact.execution_id !== execution.id) return { ok: false, problem: "wrong_execution" };
  if (artifact.mandate.id !== execution.mandate.id || artifact.mandate.version !== execution.mandate.version) {
    return { ok: false, problem: "wrong_mandate" };
  }
  if (itemsHash(execution.items) !== artifact.items_hash) return { ok: false, problem: "items_hash_mismatch" };
  // The line's own list is attested by the hash above; this is the list the
  // line was one OF. An execution that gained, lost or moved its place in a
  // batch after approval is not the one that was approved.
  if (!sameBatch(artifact.batch, execution.batch)) return { ok: false, problem: "batch_mismatch" };
  if (new Date(artifact.expires_at).getTime() <= now.getTime()) return { ok: false, problem: "expired" };
  return { ok: true };
}
