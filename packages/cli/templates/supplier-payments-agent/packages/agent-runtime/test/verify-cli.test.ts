/**
 * `codespar-agent verify` at the process boundary: the contracts a person and
 * a script depend on.
 *
 * It runs from a temporary directory with no `agent.yaml` anywhere above it
 * and no key in the environment, which is the whole claim of wave 5 — the
 * verifier is someone who has the receipt file and nothing else. The key set
 * is a local copy, so no test opens a socket.
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as signDetached } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
  it("verifies a sealed receipt from a directory with no agent and no key", () => {
    const { dir, receiptPath, keysPath } = fixture();
    const out = run([receiptPath, "--keys", keysPath], dir);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("VERIFIED");
    expect(out.stdout).toContain(RECEIPT_ID);
    expect(out.stderr).toContain("was sealed by CodeSpar");
  });

  it("puts valid JSON and nothing else on stdout with --json; the sentence goes to stderr", () => {
    const { dir, receiptPath, keysPath } = fixture();
    const out = run([receiptPath, "--keys", keysPath, "--json"], dir);
    const lines = out.stdout.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]!) as { verdict: string; kid: string; signing_string: string; message: string };
    expect(report.verdict).toBe("verified");
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
