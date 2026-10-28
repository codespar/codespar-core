/**
 * The server announces the version npm published (QA 28/10/2026: the 0.5.14 tarball said "0.5.13" in
 * `initialize`, because bin.ts carried the number as a literal the release bump missed).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MCP_VERSION } from "../version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLISHED = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const BIN = join(ROOT, "dist", "bin.js");

/** One `initialize` against the built server in setup mode (no key: nothing leaves this machine). */
function initialize(): Promise<{ name?: string; version?: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const done = (value: { name?: string; version?: string } | null) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 15_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { serverInfo?: { name?: string; version?: string } } };
          if (message.id === 1) return done(message.result?.serverInfo ?? null);
        } catch {
          // a partial line: wait for the rest
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "version-test", version: "1" } } }) + "\n");
  });
}

describe("the version the server announces", () => {
  it("is read from the package's own package.json", () => {
    expect(MCP_VERSION).toBe(PUBLISHED);
  });

  // CI builds the package before its tests (turbo: test dependsOn build); a local run without dist/ skips.
  it.skipIf(!existsSync(BIN) && !process.env["CI"])("the built server's initialize says the package.json version", async () => {
    expect(existsSync(BIN), "dist/bin.js missing: build the package before its tests").toBe(true);
    const info = await initialize();
    expect(info).toEqual({ name: "codespar", version: PUBLISHED });
  });

  it("bin.ts writes no version literal of its own", () => {
    const source = readFileSync(join(ROOT, "src", "bin.ts"), "utf8");
    expect(source).not.toMatch(/version:\s*["'`]\d+\.\d+\.\d+/);
    expect(source).not.toMatch(/VERSION\s*=\s*["'`]\d+\.\d+\.\d+/);
  });
});
