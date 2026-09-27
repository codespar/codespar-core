/**
 * `codespar-agent verify <receipt-file> [--json] [--keys <file> | --url <url>] [--approval <file> [--approval-id <id>]] [--from-api]`:
 * the wave-5 gate — someone outside verifies a receipt without access to
 * CodeSpar — and, since ent#1670, the body and the approval behind it.
 *
 * Three checks, in order, each one only on the answer of the one before:
 *
 *   1. The Ed25519 signature over `codespar-receipt:v1:<id>:<chain>`, against
 *      the public key set, fetched over plain HTTPS or read off disk.
 *   2. The chain, recomputed from the API's receipt READ under the
 *      `chain_recipe` the SAME key document publishes, held against the
 *      signed one: this is what binds the payee, the amount and the approval
 *      to the signature.
 *   3. For a v4 chain, the sealed approval link held against the local
 *      approval artifact: "this payment was made against the list H".
 *
 * The receipt file is either the read itself — what a tenant hands a third
 * party, payee unmasked; checked with no credential at all — or a copy from a
 * run's `runs/<run-id>/receipts/`, which masks the payee and carries none of
 * the links. A copy reaches check 2 only with `--from-api`: the tenant's
 * `CODESPAR_API_KEY` (the environment, or the `.env` of the agent the copy
 * sits in) reads the receipt from the API, in memory, and nothing unmasked is
 * written anywhere. Without it a copy answers `signature_only`, which is the
 * truth about what a masked copy can prove. The approval artifact of a copy
 * is the one its `approval_id` names in the run's own `approval.json`.
 *
 * It is the one command here that does NOT need an agent — `cli.ts`
 * dispatches it before it looks for an `agent.yaml` — because the file it
 * reads has usually been copied off the machine that produced it.
 *
 * `--json` follows the rule of section 14.5: machine data on stdout, valid
 * JSON and nothing else, human sentences on stderr. The exit code is the
 * verdict (`VERDICT_EXIT_CODES`), so a script branches on WHICH answer it got
 * rather than on "did it fail" — an unsigned receipt is not a failure and must
 * not exit 0 either, and neither is a signature whose body was not bound.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { stderr, stdout } from "node:process";
import {
  DEFAULT_BASE_URL,
  DEFAULT_RECEIPT_KEYS_URL,
  VERDICT_EXIT_CODES,
  copyDisagreesWithRead,
  createCodeSparClient,
  describeApiError,
  isReceiptRead,
  readSignedReceipt,
  receiptKeysUrl,
  signatureOnly,
  verifyReceiptRead,
  verifyReceiptWithKeys,
  type ApprovalClaim,
  type ExecutionItem,
  type ReceiptVerification,
} from "@codespar/agent-core";
import { findAgentDir } from "../agent.js";
import { readDotEnv } from "../setup.js";

const USAGE =
  "usage: npm run verify <receipt-file> [--json] [--keys <key-set.json> | --url <https://.../.well-known/codespar-receipt-keys.json>] [--approval <approval.json> [--approval-id <apr_...>]] [--from-api]";

/** The fetcher the key set comes through: the one unauthenticated call in this command. */
async function fetchKeyDocument(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/jwk-set+json, application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

interface Args {
  json: boolean;
  keysFile?: string;
  url?: string;
  approvalFile?: string;
  approvalId?: string;
  fromApi: boolean;
  receiptFile?: string;
}

const VALUED: readonly string[] = ["--keys", "--url", "--approval", "--approval-id"];

export async function verify(argv: string[]): Promise<number> {
  const say = (line: string) => stderr.write(line + "\n");
  const args: Args = { json: false, fromApi: false };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") args.json = true;
    else if (a === "--from-api") args.fromApi = true;
    else if (VALUED.includes(a)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        say(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === "--keys") args.keysFile = value;
      else if (a === "--url") args.url = value;
      else if (a === "--approval") args.approvalFile = value;
      else args.approvalId = value;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      say(USAGE);
      say(`the key set is public and needs no credential; its default is ${DEFAULT_RECEIPT_KEYS_URL}`);
      say("--keys reads a saved copy of that document instead, so the check runs with no network at all");
      say("the receipt file is the API's read (GET /v1/consumers/receipts/{id}), whose body is recomputed against the signed chain, or a run's copy, which proves the signature only");
      say("--from-api reads a run's copy from the API with CODESPAR_API_KEY (in memory, nothing written), so its body and its approval are checked too; the key set then defaults to that deployment's");
      say("--approval holds a v4 receipt's sealed approval link against an approval artifact (a run's copy uses its own approval.json)");
      return 0;
    } else if (a.startsWith("-")) {
      say(`unknown argument ${a}\n${USAGE}`);
      return 2;
    } else if (args.receiptFile === undefined) args.receiptFile = a;
    else {
      say(`verify takes one receipt file (got ${args.receiptFile} and ${a})\n${USAGE}`);
      return 2;
    }
  }

  if (!args.receiptFile) {
    say(USAGE);
    say("the receipt is the JSON the API returns from GET /v1/consumers/receipts/{id}, or a copy from a run's runs/<run-id>/receipts/");
    return 2;
  }
  if (args.keysFile && args.url) {
    say(`--keys and --url name two different key sets; pass one\n${USAGE}`);
    return 2;
  }
  if (args.approvalId && !args.approvalFile) {
    say(`--approval-id picks one artifact out of --approval; pass the file too\n${USAGE}`);
    return 2;
  }

  const receipt = readJson(args.receiptFile, say);
  if (receipt === undefined) return 2;

  // The read and the key set must come from ONE deployment: the recipe that
  // binds the body is the key document's, and a staging read checked under
  // production's document is the §47 trap again.
  const apiBase = process.env["CODESPAR_API_URL"]?.trim() || DEFAULT_BASE_URL;
  if (args.fromApi && args.url && new URL(args.url).origin !== new URL(apiBase).origin) {
    say(`--from-api reads the receipt from ${new URL(apiBase).origin} and --url names the key set of ${new URL(args.url).origin}; the read and the key set must come from the same deployment\n${USAGE}`);
    return 2;
  }

  let approval: ApprovalClaim | undefined;
  if (args.approvalFile) {
    const claim = readApprovalClaim(args.approvalFile, args.approvalId, say);
    if (!claim) return 2;
    approval = claim;
  }

  let keysDocument: unknown;
  if (args.keysFile) {
    keysDocument = readJson(args.keysFile, say);
    if (keysDocument === undefined) return 2;
  }

  const report = await check(receipt, args, apiBase, approval, keysDocument);
  if (args.json) stdout.write(JSON.stringify(report) + "\n");
  else stdout.write(render(report));
  say(report.message);
  return VERDICT_EXIT_CODES[report.verdict];
}

async function check(receipt: unknown, args: Args, apiBase: string, approval: ApprovalClaim | undefined, keysDocument: unknown): Promise<ReceiptVerification> {
  // Answered before the network is touched, as before: an unsigned or
  // malformed file needs no key set, and fetching one to check a signature
  // that is not there would turn an offline answer into an outage.
  const signed = readSignedReceipt(receipt);
  if (!signed.ok || signed.fields.receipt_sig_ed25519 === null) return verifyReceiptWithKeys(receipt, { keys: [] }, "none");

  let document: unknown;
  let label: string;
  if (args.keysFile) {
    label = resolve(args.keysFile);
    document = keysDocument;
  } else {
    label = args.url ?? (args.fromApi ? receiptKeysUrl(apiBase) : DEFAULT_RECEIPT_KEYS_URL);
    try {
      document = await fetchKeyDocument(label);
    } catch (err) {
      return unreachable(
        signed.fields.receipt_id,
        label,
        `the published key set could not be read from ${label}: ${err instanceof Error ? err.message : String(err)}. Nothing is proved and nothing is disproved; the keys can also be saved to a file and passed in`,
      );
    }
  }

  if (isReceiptRead(receipt)) return verifyReceiptRead(receipt, document, { label, ...(approval ? { approval } : {}) });

  // A run's copy: the signature is checked on the copy itself, as it always was.
  const signature = verifyReceiptWithKeys(receipt, document, label);
  if (signature.verdict !== "verified") return signature;
  if (!args.fromApi) {
    return signatureOnly(signature, "read_required", "this is a run's copy, which masks the payee and carries none of the chain's links. Recompute from the API's read: run this again with --from-api (the tenant's key, read-only, nothing written), or verify the read itself");
  }

  const read = await readFromApi(signed.fields.receipt_id, args.receiptFile!, apiBase);
  if (!read.ok) return signatureOnly(signature, "read_unavailable", `the API's read of it could not be fetched (${read.detail}), so nothing is proved and nothing is disproved about the body`);
  const differs = copyDisagreesWithRead(receipt as Record<string, unknown>, read.body);
  if (differs.includes("chain")) {
    // The copy's chain carries a signature that checked above, so a read with another chain is a re-seal, not an edit.
    return signatureOnly(signature, "read_resealed", "the API's read carries a different chain than this copy: the receipt was re-sealed after the copy was written (a delivery or metering update). Verify the read itself");
  }
  if (differs.length > 0) {
    return {
      ...signature,
      verdict: "chain_mismatch",
      reason: "copy_differs_from_read",
      message: `receipt ${signature.receipt_id}: this copy says something the sealed receipt does not (${differs.join(", ")}). The signature covers the id and the chain, not the copy's body, so the copy was edited after it was written`,
      chain_check: { status: "mismatch", version: null, recomputed: null, reason: "copy_differs_from_read" },
    };
  }
  const claim = approval ?? approvalOfCopy(receipt as Record<string, unknown>, args.receiptFile!);
  return verifyReceiptRead(read.body, document, { label, ...(claim ? { approval: claim } : {}) });
}

function unreachable(receiptId: string, label: string, message: string): ReceiptVerification {
  return { verdict: "unreachable", receipt_id: receiptId, kid: null, key_status: null, signing_string: null, keys_from: label, reason: "fetch_failed", message };
}

/**
 * The receipt as the API reads it, for a copy, with the tenant's key. The key
 * is the environment's, or the `.env` of the agent the copy sits in — the
 * same place `npm start` reads it from — and only a `csk_test_` key is
 * accepted, like everywhere else in this repository.
 */
async function readFromApi(receiptId: string, receiptFile: string, apiBase: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; detail: string }> {
  const agentDir = findAgentDir(dirname(resolve(receiptFile)));
  if (agentDir) readDotEnv(agentDir);
  try {
    const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: apiBase, projectId: process.env["CODESPAR_PROJECT_ID"], timeoutMs: 15_000 });
    const body: unknown = await api.get("/v1/consumers/receipts/{id}", { path: { id: receiptId } });
    if (!isReceiptRead(body)) return { ok: false, detail: "the API answered something that is not a receipt read" };
    return { ok: true, body };
  } catch (err) {
    const failure = describeApiError(err);
    return { ok: false, detail: `${failure.code}: ${failure.message}` };
  }
}

/**
 * The artifact a run's copy names by `approval_id`, from the same run's
 * `approval.json`. Found by identity: picking whichever artifact matched the
 * sealed hash would make a mismatch impossible to see.
 */
function approvalOfCopy(copy: Record<string, unknown>, receiptFile: string): ApprovalClaim | undefined {
  const id = copy["approval_id"];
  const receipts = dirname(resolve(receiptFile));
  const path = join(dirname(receipts), "approval.json");
  if (typeof id !== "string" || basename(receipts) !== "receipts" || !existsSync(path)) return undefined;
  try {
    return pickArtifact(JSON.parse(readFileSync(path, "utf8")) as unknown, id);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One artifact out of an `approval.json` (a list) or a single artifact file, as the part the approval link is held against. */
function pickArtifact(input: unknown, id: string | undefined): ApprovalClaim | undefined {
  const candidates = (Array.isArray(input) ? input : [input]).filter((a): a is Record<string, unknown> => isRecord(a) && typeof a["items_hash"] === "string" && typeof a["approval_id"] === "string");
  const chosen = id === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : candidates.find((a) => a["approval_id"] === id);
  if (!chosen) return undefined;
  const batch = chosen["batch"];
  return {
    approval_id: chosen["approval_id"] as string,
    items_hash: chosen["items_hash"] as string,
    ...(Array.isArray(chosen["items"]) ? { items: chosen["items"] as ExecutionItem[] } : {}),
    ...(isRecord(batch) && typeof batch["batch_hash"] === "string" ? { batch: { batch_hash: batch["batch_hash"] } } : {}),
  };
}

/** `--approval`: `undefined` is a usage error, already said. */
function readApprovalClaim(path: string, id: string | undefined, say: (line: string) => void): ApprovalClaim | undefined {
  const input = readJson(path, say);
  if (input === undefined) return undefined;
  const claim = pickArtifact(input, id);
  if (!claim) {
    const count = Array.isArray(input) ? input.length : 1;
    say(id ? `${resolve(path)} holds no approval artifact ${id}` : `${resolve(path)} holds ${count} approval artifacts, not one; name the one this payment carried with --approval-id`);
  }
  return claim;
}

/** A file that is missing or is not JSON is a refusal a person can act on, never a stack trace. */
function readJson(path: string, say: (line: string) => void): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    say(`could not read ${resolve(path)}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    say(`${resolve(path)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** The terminal rendering: the verdict first, then what it is about. */
function render(report: ReceiptVerification): string {
  const lines = [`${report.verdict.toUpperCase()}  ${report.receipt_id ?? "(no receipt id)"}`];
  if (report.kid) lines.push(`  key          ${report.kid}${report.key_status ? ` (${report.key_status})` : ""}`);
  if (report.keys_from) lines.push(`  key set      ${report.keys_from}`);
  if (report.signing_string) lines.push(`  signed       ${report.signing_string}`);
  if (report.chain_check) {
    const c = report.chain_check;
    lines.push(`  body         ${c.status}${c.version !== null ? ` (chain v${c.version})` : ""}${c.recomputed && c.status === "mismatch" ? `, recomputes to ${c.recomputed}` : ""}`);
  }
  if (report.approval_check) {
    const a = report.approval_check;
    lines.push(`  approval     ${a.status}: sealed ${a.sealed.items_hash}${a.sealed.batch_hash ? ` batch ${a.sealed.batch_hash}` : ""}`);
    if (a.artifact) lines.push(`               artifact ${a.artifact.approval_id} ${a.artifact.items_hash}${a.artifact.batch_hash ? ` batch ${a.artifact.batch_hash}` : ""}`);
  }
  lines.push(`  reason       ${report.reason}`);
  return lines.join("\n") + "\n";
}
