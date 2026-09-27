#!/usr/bin/env node
/**
 * Runs the WhatsApp Cloud API emulator the channel's `simulator` backend talks
 * to: `dyvit-wa-sim`, published as `@dyvit/whatsapp-simulator-cli` (MIT) from
 * https://github.com/fabianocruz/whatsapp-simulator. It is not ours and it is
 * not a dependency of this workspace.
 *
 * WHY NOT A DEPENDENCY. It is a development tool. Nothing in `packages/` or
 * `agents/` imports it, so `npm ci` has no reason to fetch it and a contributor
 * who never runs the WhatsApp gate never downloads it. `npx` fetches the exact
 * version into its own cache the first time it is needed; nothing is vendored,
 * nothing is installed globally, and the repository's tree is untouched.
 *
 * WHY PINNED TO A VERSION. A moving `latest` would make our gate fail on
 * somebody else's release. `--version` overrides, and there is no `latest`.
 * The spec handed to `npx` is exact, so it cannot resolve anything else.
 *
 * Usage:
 *   node scripts/whatsapp-emulator.mjs                   start it (foreground)
 *   node scripts/whatsapp-emulator.mjs --prepare         fetch only
 *   node scripts/whatsapp-emulator.mjs --version <v>     a different release
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const EMULATOR_PACKAGE = "@dyvit/whatsapp-simulator-cli";
/** The release the gate is measured against. Bump deliberately, never automatically. */
export const EMULATOR_VERSION = "0.3.0";
export const EMULATOR_PORT = 4290;
/** Must match `WHATSAPP_SIM_APP_SECRET`. A local development value, not a credential. */
export const EMULATOR_APP_SECRET = "dev";
/** Where the channel's own receiver listens; the emulator posts its webhooks there. */
export const EMULATOR_WEBHOOK_PORT = 4399;

function spec(version) {
  return `${EMULATOR_PACKAGE}@${version}`;
}

/** Warms `npx`'s cache so the start below does not race a download. */
export function prepare(version = EMULATOR_VERSION, say = (l) => process.stderr.write(l + "\n")) {
  say(`whatsapp emulator: fetching ${spec(version)}`);
  const result = spawnSync("npx", ["--yes", spec(version), "--help"], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`could not fetch ${spec(version)} (npx exited ${result.status}). Is the version published, and is the network reachable?`);
  }
  return spec(version);
}

function serve(version, webhookUrl) {
  const child = spawn(
    "npx",
    ["--yes", spec(version), "serve", "--port", String(EMULATOR_PORT), "--webhook", webhookUrl, "--app-secret", EMULATOR_APP_SECRET],
    // Its own process group: `npx` is a wrapper around the real server, and a
    // signal sent to the wrapper alone leaves the port held by an orphan.
    { cwd: ROOT, stdio: "inherit", detached: true },
  );
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const version = argv.includes("--version") ? argv[argv.indexOf("--version") + 1] : EMULATOR_VERSION;
  const webhookUrl = argv.includes("--webhook") ? argv[argv.indexOf("--webhook") + 1] : `http://127.0.0.1:${EMULATOR_WEBHOOK_PORT}/`;
  if (argv.includes("--prepare")) {
    prepare(version);
    process.stderr.write(`whatsapp emulator ready: ${spec(version)}\n`);
  } else {
    process.stderr.write(`whatsapp emulator: ${spec(version)} on :${EMULATOR_PORT}, webhooks to ${webhookUrl}\n`);
    serve(version, webhookUrl);
  }
}
