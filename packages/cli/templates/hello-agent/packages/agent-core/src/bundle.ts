/**
 * Section 11: the proof bundle, one folder per run under `runs/<run-id>/`.
 * It answers "why could the agent pay this". It holds no key and no secret;
 * payee keys are masked the way a bank statement masks them.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Mandate } from "./mandate.js";
import type { RailReceipt } from "./rail.js";
import type { ApprovalArtifact } from "./types.js";

export interface TranscriptLine {
  at: string;
  kind: "user" | "assistant_step" | "tool_call" | "tool_result" | "assistant" | "system";
  [key: string]: unknown;
}

export class ProofBundle {
  readonly dir: string;

  constructor(
    runsDir: string,
    readonly runId: string,
  ) {
    this.dir = join(runsDir, runId);
    mkdirSync(join(this.dir, "receipts"), { recursive: true });
  }

  static open(runsDir: string, runId: string): ProofBundle | undefined {
    return existsSync(join(runsDir, runId)) ? new ProofBundle(runsDir, runId) : undefined;
  }

  transcript(line: TranscriptLine): void {
    appendFileSync(join(this.dir, "transcript.jsonl"), JSON.stringify(line) + "\n");
  }

  readTranscript(): TranscriptLine[] {
    const path = join(this.dir, "transcript.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TranscriptLine);
  }

  event(event: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(event) + "\n");
  }

  /**
   * The conversation, when the run had one: every message in and out of a
   * channel, in order, with what the channel did with it. Separate from the
   * transcript, which is the MODEL's side, because on a channel the two are
   * not the same thing — a message the channel refused never reached the
   * person, and the QR and the copy-and-paste were sent by the runner.
   *
   * It carries no contact in the clear: the channel masks it before it gets
   * here, because the bundle travels.
   */
  channel(line: Record<string, unknown>): void {
    appendFileSync(join(this.dir, "channel.jsonl"), JSON.stringify(line) + "\n");
  }

  readChannel(): Record<string, unknown>[] {
    const path = join(this.dir, "channel.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  readEvents(): Record<string, unknown>[] {
    const path = join(this.dir, "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** `approval.json` is the list of artifacts of this run, in approval order. */
  approval(artifact: ApprovalArtifact): void {
    const path = join(this.dir, "approval.json");
    const current: ApprovalArtifact[] = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ApprovalArtifact[]) : [];
    if (!current.some((a) => a.approval_id === artifact.approval_id)) current.push(artifact);
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  }

  readApprovals(): ApprovalArtifact[] {
    const path = join(this.dir, "approval.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ApprovalArtifact[]) : [];
  }

  mandateSnapshot(mandate: Mandate): void {
    const { signature: _signature, canonical: _canonical, ...safe } = mandate;
    writeFileSync(join(this.dir, "mandate.snapshot.json"), JSON.stringify({ ...safe, beneficiaries: safe.beneficiaries.map((b) => ({ ...b, payee: maskPayee(b.payee) })), merchant_allowlist: safe.merchant_allowlist.map(maskPayee) }, null, 2) + "\n");
  }

  /** Returns the path INSIDE the bundle (`receipts/<id>.json`): a bundle travels, and an absolute path names the machine that wrote it. */
  receipt(receipt: RailReceipt): string {
    const relative = join("receipts", `${receipt.receipt_id}.json`);
    const { raw: _raw, ...safe } = receipt;
    writeFileSync(join(this.dir, relative), JSON.stringify({ ...safe, payment: { ...safe.payment, payee: safe.payment.payee ? maskPayee(safe.payment.payee) : null } }, null, 2) + "\n");
    return relative;
  }

  /** The masked mandate as it stood when the run started. Absent on a bundle whose run never got that far. */
  readMandateSnapshot(): Record<string, unknown> | undefined {
    const path = join(this.dir, "mandate.snapshot.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
  }

  /** One receipt by its file name, as `listReceipts()` returns it. */
  readReceipt(file: string): Record<string, unknown> | undefined {
    const path = join(this.dir, "receipts", basename(file));
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
  }

  /**
   * Section 11: `verify.json` is the output of `codespar audit replay`, which
   * is not a registered command of the CLI, so nothing here writes it and
   * nothing here reimplements the hash-chain check. The reader exists so a
   * bundle that gains one later is noticed rather than ignored.
   */
  hasVerify(): boolean {
    return existsSync(join(this.dir, "verify.json"));
  }

  listReceipts(): string[] {
    const dir = join(this.dir, "receipts");
    if (!existsSync(dir)) return [];
    return readdirSorted(dir);
  }

  meta(meta: Record<string, unknown>): void {
    writeFileSync(join(this.dir, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  }

  readMeta(): Record<string, unknown> | undefined {
    const path = join(this.dir, "run.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : undefined;
  }
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/** `escola@exemplo.com.br` -> `es***@exemplo.com.br`; `+5511999998888` -> `+55***8888`; a UUID keeps its first and last 4. */
export function maskPayee(payee: string): string {
  if (payee === "*") return payee;
  const at = payee.indexOf("@");
  if (at > 0) return `${payee.slice(0, Math.min(2, at))}***${payee.slice(at)}`;
  if (payee.length <= 8) return `${payee.slice(0, 2)}***`;
  return `${payee.slice(0, 4)}***${payee.slice(-4)}`;
}
