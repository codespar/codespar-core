/**
 * `codespar-agent verify <receipt-file> [--json] [--keys <file>] [--url <url>]`:
 * the wave-5 gate — someone outside verifies a receipt without access to
 * CodeSpar.
 *
 * It takes a receipt JSON, fetches the public key set over plain HTTPS (or
 * reads a copy off disk, for a machine with no network), and checks the
 * Ed25519 signature with stock `node:crypto`. No CodeSpar key, no API key, no
 * SDK call: the verifier holds nothing, and that is what makes the answer
 * worth anything. It is the one command here that does NOT need an agent —
 * `cli.ts` dispatches it before it looks for an `agent.yaml` — because the
 * file it reads has usually been copied off the machine that produced it.
 *
 * `--json` follows the rule of section 14.5: machine data on stdout, valid
 * JSON and nothing else, human sentences on stderr. The exit code is the
 * verdict (`VERDICT_EXIT_CODES`), so a script branches on WHICH answer it got
 * rather than on "did it fail" — an unsigned receipt is not a failure and must
 * not exit 0 either.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stderr, stdout } from "node:process";
import { DEFAULT_RECEIPT_KEYS_URL, VERDICT_EXIT_CODES, verifyReceipt, type KeySource, type ReceiptVerification } from "@codespar/agent-core";

const USAGE = "usage: npm run verify <receipt-file> [--json] [--keys <key-set.json>] [--url <https://.../.well-known/codespar-receipt-keys.json>]";

/** The fetcher the module is given. The only network in this feature, and it
 *  lives here rather than in the core so a unit test injects its own. */
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

export async function verify(argv: string[]): Promise<number> {
  const say = (line: string) => stderr.write(line + "\n");
  let json = false;
  let keysFile: string | undefined;
  let url: string | undefined;
  let receiptFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--keys" || a === "--url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        say(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === "--keys") keysFile = value;
      else url = value;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      say(USAGE);
      say(`the key set is public and needs no credential; its default is ${DEFAULT_RECEIPT_KEYS_URL}`);
      say("--keys reads a saved copy of that document instead, so the check runs with no network at all");
      return 0;
    } else if (a.startsWith("-")) {
      say(`unknown argument ${a}\n${USAGE}`);
      return 2;
    } else if (receiptFile === undefined) receiptFile = a;
    else {
      say(`verify takes one receipt file (got ${receiptFile} and ${a})\n${USAGE}`);
      return 2;
    }
  }

  if (!receiptFile) {
    say(USAGE);
    say("the receipt is the JSON the API returns from GET /v1/consumers/receipts/{id}, or a copy from a run's runs/<run-id>/receipts/");
    return 2;
  }
  if (keysFile && url) {
    say(`--keys and --url name two different key sets; pass one\n${USAGE}`);
    return 2;
  }

  const receipt = readJson(receiptFile, say);
  if (receipt === undefined) return 2;

  let source: KeySource;
  if (keysFile) {
    const document = readJson(keysFile, say);
    if (document === undefined) return 2;
    source = { document, label: resolve(keysFile) };
  } else {
    source = { url: url ?? DEFAULT_RECEIPT_KEYS_URL, fetch: fetchKeyDocument };
  }

  const report = await verifyReceipt(receipt, source);
  if (json) stdout.write(JSON.stringify(report) + "\n");
  else stdout.write(render(report));
  say(report.message);
  return VERDICT_EXIT_CODES[report.verdict];
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
  lines.push(`  reason       ${report.reason}`);
  return lines.join("\n") + "\n";
}
