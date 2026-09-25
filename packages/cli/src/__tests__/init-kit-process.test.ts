/**
 * `codespar init <name> --template bills-agent` at the process level.
 *
 * The first block runs everywhere: the scaffold is the packaged template,
 * byte for byte, with `{{name}}` substituted in the two generated files and
 * `_gitignore` renamed. No network.
 *
 * The second block installs the scaffold and runs the kit's own gates
 * (`npm run check`, then one turn on the replay provider with no keys). It
 * reaches the npm registry and takes tens of seconds, so it runs only with
 * CODESPAR_CLI_KIT_E2E=1 — set in the CI job that owns it, not in `npm test`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { hashTree } from "../../scripts/sync-kit-templates.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "../../dist/index.js");
const TEMPLATES = join(HERE, "../../templates");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const E2E = process.env.CODESPAR_CLI_KIT_E2E === "1";

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function cli(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: { ...process.env, CODESPAR_API_KEY: "", CODESPAR_BASE_URL: "" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function npm(args: string[], cwd: string, timeout = 300_000) {
  const r = spawnSync(NPM, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    shell: process.platform === "win32",
    env: { ...process.env, CODESPAR_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function scaffold(slug: string, name: string) {
  const cwd = mkdtempSync(join(tmpdir(), "codespar-init-kit-"));
  scratchDirs.push(cwd);
  const r = cli(["init", name, "--template", slug], cwd);
  return { ...r, dir: join(cwd, name) };
}

describe("codespar init --template <kit>", () => {
  it("needs the build: dist/index.js exists", () => {
    expect(existsSync(BIN), "dist/index.js is missing — run `npm run build` in packages/cli first").toBe(true);
  });

  it("scaffolds bills-agent offline: the packaged bytes, the name substituted, .gitignore restored", () => {
    const r = scaffold("bills-agent", "my-bills");
    expect(r.status, r.stderr).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("Created my-bills/");
    expect(r.stdout).toContain("cp agents/bills-agent/.env.example agents/bills-agent/.env");
    expect(r.stdout).toContain("npm install");
    expect(r.stdout).toContain("npm run consent -- --yes");
    expect(r.stdout).toContain("npm start");

    expect(existsSync(join(r.dir, "agents/bills-agent/agent.yaml"))).toBe(true);
    expect(existsSync(join(r.dir, "packages/agent-core/package.json"))).toBe(true);
    expect(existsSync(join(r.dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(r.dir, "_gitignore"))).toBe(false);
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toContain(".codespar/");
    expect(JSON.parse(readFileSync(join(r.dir, "package.json"), "utf8")).name).toBe("my-bills");

    // Everything the kits wrote is byte-identical to the packaged template;
    // only the two generated files carry the name, and the ignore file moved.
    const packaged = hashTree(join(TEMPLATES, "bills-agent"));
    const scaffolded = hashTree(r.dir);
    for (const [file, sha] of packaged) {
      if (file === "package.json" || file === "README.md") continue;
      const outFile = file === "_gitignore" ? ".gitignore" : file;
      expect(scaffolded.get(outFile), `${outFile} differs from the packaged template`).toBe(sha);
    }
    expect(scaffolded.size).toBe(packaged.size);
  }, 60_000);

  it("scaffolds collections-agent too, without a consent step", () => {
    const r = scaffold("collections-agent", "my-collections");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(r.dir, "agents/collections-agent/agent.yaml"))).toBe(true);
    expect(r.stdout).not.toContain("consent");
    expect(r.stdout).toContain("cp agents/collections-agent/.env.example agents/collections-agent/.env");
  }, 60_000);

  it("--json answers a document with the next steps and nothing else on stdout", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codespar-init-kit-json-"));
    scratchDirs.push(cwd);
    const r = cli(["--json", "init", "j", "--template", "bills-agent"], cwd);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc).toMatchObject({ created: "j", template: "bills-agent", kind: "kit" });
    expect(doc.next_steps).toContain("npm run consent -- --yes");
  }, 60_000);

  it("--list shows the kits with a one-line description each, and refuses an unknown slug naming them", () => {
    const cwd = mkdtempSync(join(tmpdir(), "codespar-init-list-"));
    scratchDirs.push(cwd);
    const list = cli(["init", "--list"], cwd);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain("bills-agent");
    expect(list.stdout).toContain("collections-agent");
    expect(list.stdout).toContain("pays under a signed mandate");

    const bad = cli(["init", "x", "--template", "no-such-kit"], cwd);
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toContain("bills-agent");
    expect(existsSync(join(cwd, "x"))).toBe(false);
  }, 60_000);
});

describe.skipIf(!E2E)("the scaffold works standalone (CODESPAR_CLI_KIT_E2E=1)", () => {
  it("bills-agent: npm install, npm run check, one turn on the replay provider", () => {
    const r = scaffold("bills-agent", "e2e-bills");
    expect(r.status, r.stderr).toBe(0);

    const install = npm(["install", "--no-audit", "--no-fund", "--loglevel=error"], r.dir);
    expect(install.status, install.stderr).toBe(0);
    expect(existsSync(join(r.dir, "node_modules/@codespar/agent-core/package.json"))).toBe(true);

    const check = npm(["run", "check"], r.dir);
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
    expect(check.stderr).toContain("check ok: bills-agent");

    const turn = npm(["start", "--silent", "--", "--input", "pague a escola de outubro", "--approve", "--json"], join(r.dir, "agents/bills-agent"));
    expect(turn.status, `${turn.stdout}\n${turn.stderr}`).toBe(0);
    const doc = JSON.parse(turn.stdout);
    expect(doc.executions[0].state).toBe("settled");
    expect(doc.receipts).toHaveLength(1);
  }, 600_000);

  // Every OTHER kit the lock names, derived. Naming them one by one is how the
  // two agents kits 8f130b7 added would have shipped unproven: the gate that
  // matters is "a freshly generated template installs and passes its own
  // check", and it has to be asked of all of them, not of the two somebody
  // remembered to write down.
  const others = Object.keys(
    (JSON.parse(readFileSync(join(TEMPLATES, "kits.lock.json"), "utf8")) as { templates: Record<string, unknown> }).templates,
  ).filter((slug) => slug !== "bills-agent");

  it.each(others)("%s: npm install and npm run check", (slug) => {
    const r = scaffold(slug, `e2e-${slug}`);
    expect(r.status, r.stderr).toBe(0);

    const install = npm(["install", "--no-audit", "--no-fund", "--loglevel=error"], r.dir);
    expect(install.status, install.stderr).toBe(0);
    // The vendored packages resolved through the workspace link rather than
    // being fetched: this is the 404 of 25/09, asked of the installed tree.
    for (const pkg of Object.keys(
      (JSON.parse(readFileSync(join(r.dir, "agents", slug, "package.json"), "utf8")) as { dependencies?: Record<string, string> })
        .dependencies ?? {},
    ).filter((d) => d.startsWith("@codespar/agent-"))) {
      expect(existsSync(join(r.dir, "node_modules", pkg, "package.json")), `${slug}: ${pkg} did not install`).toBe(true);
    }

    const check = npm(["run", "check"], r.dir);
    expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0);
    expect(check.stderr).toContain(`check ok: ${slug}`);
  }, 600_000);
});
