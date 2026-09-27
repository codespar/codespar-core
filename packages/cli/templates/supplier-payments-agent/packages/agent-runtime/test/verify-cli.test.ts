/**
 * `codespar-agent verify` at the process boundary: the contracts a person and
 * a script depend on.
 *
 * It runs from a temporary directory with no `agent.yaml` anywhere above it
 * and no key in the environment, which is the whole claim of wave 5 — the
 * verifier is someone who has the receipt file and nothing else. The key set
 * is a local copy, so no test opens a socket.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signDetached } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalize, itemsHash, maskPayee, type ExecutionItem } from "@codespar/agent-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = resolve(import.meta.dirname, "../bin.mjs");
const KID = "did:web:id.codespar.dev#1";
const CHAIN = "9f2c4a1b6d0e8f3a5c7b9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f01";
const RECEIPT_ID = "rcpt_V1StGXR8Z5jdHi6BmyT0sw";

function fixture(over: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "verify-cli-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const signature = signDetached(null, Buffer.from(`codespar-receipt:v1:${RECEIPT_ID}:${CHAIN}`, "utf8"), privateKey).toString("base64url");
  const receipt = {
    receipt_id: RECEIPT_ID,
    state: "paid",
    mandate: { id: "mnd_1" },
    payment: { amount_minor: 12345, payee: "es***@exemplo.com.br", attempt_id: "att_1", money_moved: false, sandbox: true, at: "2026-09-24T12:00:00.000Z" },
    chain: CHAIN,
    receipt_sig: "hmac-half",
    receipt_sig_ed25519: signature,
    receipt_sig_kid: KID,
    ...over,
  };
  const keys = { issuer: "did:web:id.codespar.dev", algorithm: "Ed25519", signing_string: "codespar-receipt:v1:<receipt_id>:<chain>", keys: [{ kid: KID, kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", status: "active", created_at: "2026-09-01T00:00:00.000Z", retired_at: null }] };
  const receiptPath = join(dir, "receipt.json");
  const keysPath = join(dir, "codespar-receipt-keys.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(keysPath, JSON.stringify(keys, null, 2) + "\n");
  return { dir, receiptPath, keysPath };
}

function run(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [BIN, "verify", ...args], {
    cwd,
    // No CodeSpar key, no model key: a verifier holds nothing.
    env: { ...process.env, CODESPAR_API_KEY: "", ANTHROPIC_API_KEY: "" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("codespar-agent verify", () => {
  it("checks a run's copy from a directory with no agent and no key, and says it proves the signature only (exit 7)", () => {
    const { dir, receiptPath, keysPath } = fixture();
    const out = run([receiptPath, "--keys", keysPath], dir);
    expect(out.code).toBe(7);
    expect(out.stdout).toContain("SIGNATURE_ONLY");
    expect(out.stdout).toContain(RECEIPT_ID);
    expect(out.stdout).toContain("read_required");
    expect(out.stderr).toContain("carries CodeSpar's signature");
    expect(out.stderr).toContain("--from-api");
  });

  it("puts valid JSON and nothing else on stdout with --json; the sentence goes to stderr", () => {
    const { dir, receiptPath, keysPath } = fixture();
    const out = run([receiptPath, "--keys", keysPath, "--json"], dir);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as { verdict: string; kid: string; signing_string: string; message: string };
    expect(report.verdict).toBe("signature_only");
    expect(report.kid).toBe(KID);
    expect(report.signing_string).toBe(`codespar-receipt:v1:${RECEIPT_ID}:${CHAIN}`);
    expect(out.stderr).toContain(report.message);
  });

  it("exits 1 and says so on a receipt that does not match its signature", () => {
    const { dir, receiptPath, keysPath } = fixture({ chain: CHAIN.replace(/^9/, "8") });
    const out = run([receiptPath, "--keys", keysPath], dir);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("TAMPERED");
  });

  it("exits 3 on a receipt sealed before Ed25519, and calls it what it is", () => {
    const { dir, receiptPath, keysPath } = fixture({ receipt_sig_ed25519: null, receipt_sig_kid: null });
    const out = run([receiptPath, "--keys", keysPath], dir);
    expect(out.code).toBe(3);
    expect(out.stdout).toContain("UNSIGNED");
    expect(out.stderr).toContain("never will");
  });

  it("exits 4 when the key set does not publish the kid the receipt names", () => {
    const { dir, receiptPath, keysPath } = fixture({ receipt_sig_kid: "did:web:id.codespar.dev#9" });
    const out = run([receiptPath, "--keys", keysPath], dir);
    expect(out.code).toBe(4);
    expect(out.stdout).toContain("UNKNOWN_KEY");
  });

  it("exits 5 when the key set cannot be read: unknown, never invalid", () => {
    const { dir, receiptPath } = fixture();
    const empty = join(dir, "not-a-key-set.json");
    writeFileSync(empty, '{"error":"not found"}\n');
    const out = run([receiptPath, "--keys", empty], dir);
    expect(out.code).toBe(5);
    expect(out.stdout).toContain("UNREACHABLE");
  });

  it("exits 6 rather than calling an arbitrary JSON file an unsigned receipt", () => {
    const { dir, keysPath } = fixture();
    const other = join(dir, "something-else.json");
    writeFileSync(other, '{"hello":"world"}\n');
    const out = run([other, "--keys", keysPath], dir);
    expect(out.code).toBe(6);
    expect(out.stdout).toContain("MALFORMED");
  });

  it("refuses its arguments with 2, the way the other commands do", () => {
    const { dir, receiptPath, keysPath } = fixture();
    expect(run([], dir).code).toBe(2);
    expect(run([receiptPath, "--keys", keysPath, "--url", "https://example.invalid/k.json"], dir).code).toBe(2);
    expect(run([receiptPath, "--keys"], dir).code).toBe(2);
    expect(run([join(dir, "missing.json"), "--keys", keysPath], dir).code).toBe(2);
    expect(run(["--help"], dir).code).toBe(0);
  });
});

/*
 * The body and the approval (OPEN_QUESTIONS §3, §47). A v4 receipt read, its
 * chain written out link by link and signed with a key generated here, under
 * the recipe production published on 2026-09-26.
 */
const PUBLISHED = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../agent-core/test/fixtures/production-receipt-keys.json"), "utf8")) as Record<string, unknown>;
const V4_KID = "did:web:id.codespar.dev#production-2";
const PAYEE = "escola@exemplo.com.br";
const ITEMS: ExecutionItem[] = [{ alias: "escola", beneficiary: "Escola Aurora", payee: PAYEE, amount: 185000, currency: "BRL", description: "outubro" }];
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function v4Fixture(sealedItemsHash = itemsHash(ITEMS)) {
  const dir = mkdtempSync(join(tmpdir(), "verify-cli-v4-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const mandate = { id: "cm_test_1", nonce: "nonce-1", scope: "contas do mes", currency: "BRL", sig_sha256: sha256("s".repeat(64)) };
  const quote = { seller: "Escola Aurora", resource: "outubro", price_minor: 185000, payee: PAYEE, session_id: null, sig: "q".repeat(64), at: "2026-09-26T18:00:00.000Z" };
  const approval = { items_hash: sealedItemsHash, batch_hash: null };
  const payment = { rail: "pix-consent", provider: "pix", tx_id: "tx_1", amount_minor: 185000, amount_atomic: null, sandbox: true, attempt_id: "att_1_0", money_moved: false, at: "2026-09-26T18:00:01.000Z" };
  const chain = sha256(
    canonicalize({
      v: 4,
      links: [
        mandate,
        quote,
        approval,
        { rail: payment.rail, provider: payment.provider, tx_id: payment.tx_id, amount_minor: payment.amount_minor, sandbox: true, attempt_id: payment.attempt_id, money_moved: false, at: payment.at },
      ],
    }),
  );
  const signature = signDetached(null, Buffer.from(`codespar-receipt:v1:${RECEIPT_ID}:${chain}`, "utf8"), privateKey).toString("base64url");
  const read = { receipt_id: RECEIPT_ID, state: "paid", chain_version: 4, mandate, quote, approval, payment, delivery: null, chain, receipt_sig: "hmac-not-read-here", receipt_sig_ed25519: signature, receipt_sig_kid: V4_KID, exceptions: [] };
  const keys = { ...PUBLISHED, keys: [{ kid: V4_KID, kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", status: "active" }] };
  const artifact = { approval_id: "apr_1", execution_id: "exe_1", items: ITEMS, items_hash: itemsHash(ITEMS), approved_at: "2026-09-26T18:00:00.000Z" };

  // A run's bundle, as the engine writes it: the masked copy naming its artifact, and approval.json beside receipts/.
  const run = join(dir, "runs", "run_1");
  mkdirSync(join(run, "receipts"), { recursive: true });
  const copy = {
    receipt_id: RECEIPT_ID,
    state: "paid",
    mandate: { id: mandate.id },
    payment: { amount_minor: 185000, payee: maskPayee(PAYEE), attempt_id: payment.attempt_id, money_moved: false, sandbox: true, at: payment.at },
    chain,
    receipt_sig: "hmac-not-read-here",
    receipt_sig_ed25519: signature,
    receipt_sig_kid: V4_KID,
    actor: { type: "agent", agent: "bills-agent@0.1.0", on_behalf_of: "usr_demo" },
    approval_id: artifact.approval_id,
  };
  const paths = {
    read: join(dir, "receipt-read.json"),
    keys: join(dir, "codespar-receipt-keys.json"),
    artifact: join(dir, "approval.json"),
    copy: join(run, "receipts", `${RECEIPT_ID}.json`),
    runApprovals: join(run, "approval.json"),
  };
  writeFileSync(paths.read, JSON.stringify(read, null, 2) + "\n");
  writeFileSync(paths.keys, JSON.stringify(keys, null, 2) + "\n");
  writeFileSync(paths.artifact, JSON.stringify([artifact], null, 2) + "\n");
  writeFileSync(paths.copy, JSON.stringify(copy, null, 2) + "\n");
  writeFileSync(paths.runApprovals, JSON.stringify([artifact], null, 2) + "\n");
  return { dir, read, keys, copy, artifact, paths };
}

describe("codespar-agent verify, the body and the approval of a v4 receipt read", () => {
  it("exits 0 when the chain recomputes from the read and the sealed approval is the artifact's", () => {
    const f = v4Fixture();
    const out = run([f.paths.read, "--keys", f.paths.keys, "--approval", f.paths.artifact], f.dir);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("VERIFIED");
    expect(out.stdout).toContain("body         recomputed (chain v4)");
    expect(out.stdout).toContain("approval     matched");
    expect(out.stderr).toContain("paid against the list artifact apr_1 approved");
  });

  it("exits 9, approval_mismatch, when the receipt sealed another list than the artifact's", () => {
    const f = v4Fixture(`sha256:${"9".repeat(64)}`);
    const out = run([f.paths.read, "--keys", f.paths.keys, "--approval", f.paths.artifact, "--json"], f.dir);
    expect(out.code).toBe(9);
    const report = JSON.parse(out.stdout) as { verdict: string; reason: string; approval_check: { status: string } };
    expect(report).toMatchObject({ verdict: "approval_mismatch", reason: "items_hash_differs", approval_check: { status: "mismatch" } });
  });

  it("exits 8, chain_mismatch, when the payee beside a genuine signature was changed", () => {
    const f = v4Fixture();
    writeFileSync(f.paths.read, JSON.stringify({ ...f.read, quote: { ...f.read.quote, payee: "outra@exemplo.com.br" } }));
    const out = run([f.paths.read, "--keys", f.paths.keys, "--approval", f.paths.artifact], f.dir);
    expect(out.code).toBe(8);
    expect(out.stdout).toContain("CHAIN_MISMATCH");
  });

  it("exits 7 for a v2 read, and says the chain is not recomputable without the mandate signature", () => {
    const f = v4Fixture();
    writeFileSync(f.paths.read, JSON.stringify({ ...f.read, chain_version: 2 }));
    const out = run([f.paths.read, "--keys", f.paths.keys], f.dir);
    expect(out.code).toBe(7);
    expect(out.stderr).toContain("not recomputable without the mandate signature");
  });

  it("refuses an --approval file with more than one artifact unless --approval-id names one", () => {
    const f = v4Fixture();
    writeFileSync(f.paths.artifact, JSON.stringify([f.artifact, { ...f.artifact, approval_id: "apr_2" }]));
    expect(run([f.paths.read, "--keys", f.paths.keys, "--approval", f.paths.artifact], f.dir).code).toBe(2);
    expect(run([f.paths.read, "--keys", f.paths.keys, "--approval", f.paths.artifact, "--approval-id", "apr_1"], f.dir).code).toBe(0);
    expect(run([f.paths.read, "--keys", f.paths.keys, "--approval-id", "apr_1"], f.dir).code).toBe(2);
  });
});

/*
 * `--from-api`: a run's masked copy, bound through the API's read. A local
 * server plays the deployment — the receipt route and its well-known key set —
 * so the read and the key set come from ONE origin, as the command requires.
 */
describe("codespar-agent verify --from-api", () => {
  let server: Server;
  let baseUrl: string;
  let served: { read: unknown; keys: unknown } = { read: {}, keys: {} };
  const asked: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers["authorization"] ? "auth" : "anon"}`);
      const body = req.url === "/.well-known/codespar-receipt-keys.json" ? served.keys : req.url === `/v1/consumers/receipts/${RECEIPT_ID}` ? served.read : undefined;
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { error: { code: "not_found", message: "no" } }));
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });

  /** The server answers while the command runs, so the process is awaited, never spawned synchronously. */
  function runAsync(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = spawn(process.execPath, [BIN, "verify", ...args], {
        cwd,
        // The placeholder passes the csk_test_ guard and is the one test-key-shaped string the secret scan allows.
        env: { ...process.env, CODESPAR_API_KEY: "csk_test_your_key_here", CODESPAR_API_URL: baseUrl, ANTHROPIC_API_KEY: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => done({ code, stdout, stderr }));
    });
  }

  it("binds the copy's body through the read and checks the run's own artifact: exit 0, and nothing unmasked is written", async () => {
    const f = v4Fixture();
    served = { read: f.read, keys: f.keys };
    asked.length = 0;
    const out = await runAsync([f.paths.copy, "--from-api"], f.dir);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("approval     matched");
    expect(asked).toEqual([`GET /.well-known/codespar-receipt-keys.json anon`, `GET /v1/consumers/receipts/${RECEIPT_ID} auth`]);
    expect(readFileSync(f.paths.copy, "utf8")).not.toContain(PAYEE);
  });

  it("exits 9 when the run's artifact is not the list the receipt sealed", async () => {
    const f = v4Fixture();
    served = { read: f.read, keys: f.keys };
    writeFileSync(f.paths.runApprovals, JSON.stringify([{ ...f.artifact, items: [{ ...ITEMS[0]!, amount: 1 }], items_hash: itemsHash([{ ...ITEMS[0]!, amount: 1 }]) }]));
    const out = await runAsync([f.paths.copy, "--from-api", "--json"], f.dir);
    expect(out.code).toBe(9);
    expect(JSON.parse(out.stdout)).toMatchObject({ verdict: "approval_mismatch", reason: "items_hash_differs" });
  });

  it("exits 8 when the copy was edited after it was written: the signature does not cover its body, the read does", async () => {
    const f = v4Fixture();
    served = { read: f.read, keys: f.keys };
    writeFileSync(f.paths.copy, JSON.stringify({ ...f.copy, payment: { ...f.copy.payment, amount_minor: 1 } }));
    const out = await runAsync([f.paths.copy, "--from-api", "--json"], f.dir);
    expect(out.code).toBe(8);
    expect(JSON.parse(out.stdout)).toMatchObject({ verdict: "chain_mismatch", reason: "copy_differs_from_read" });
  });

  it("answers signature_only, never a failure, when the read cannot be fetched", async () => {
    const f = v4Fixture();
    served = { read: undefined as unknown, keys: f.keys };
    const out = await runAsync([f.paths.copy, "--from-api", "--json"], f.dir);
    expect(out.code).toBe(7);
    expect(JSON.parse(out.stdout)).toMatchObject({ verdict: "signature_only", reason: "read_unavailable" });
  });

  it("refuses a key set from another deployment than the read", async () => {
    const f = v4Fixture();
    const out = await runAsync([f.paths.copy, "--from-api", "--url", "https://api.codespar.dev/.well-known/codespar-receipt-keys.json"], f.dir);
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("same deployment");
  });
});
