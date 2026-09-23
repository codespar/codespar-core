#!/usr/bin/env node
// sync-kit-templates.mjs — the agents of codespar/agent-starter-kits become
// `codespar init --template <name>` templates, copied into this package at
// RELEASE time by this script. `init` never reaches GitHub: what it scaffolds
// is what the published tarball carries, so it works offline, is pinned to
// one kits commit, and two installs of the same CLI version scaffold the same
// bytes.
//
// Layout of a generated template (packages/cli/templates/<name>/):
//
//   package.json            generated: an npm workspace over the two dirs below
//   README.md               generated: provenance + the quick path
//   LICENSE, _gitignore,    the kits repo's own root files, verbatim (init
//   tsconfig.base.json,     renames _gitignore back: npm ships no .gitignore)
//   vitest.config.ts
//   packages/agent-core/    @codespar/agent-core, verbatim (not on npm yet)
//   agents/<name>/          the agent, verbatim
//
// The layout mirrors the kits repo on purpose. Every relative path inside a
// kit — `extends: ../../tsconfig.base.json`, `vitest --root ../..`, the
// `.env` the agent reads from its own directory, the paths its README and
// AGENTS.md name — keeps resolving, and the agent's `"@codespar/agent-core":
// "0.1.0"` pin resolves to the vendored copy through the workspace link, the
// same mechanism the kits repo itself relies on. Nothing under `agents/` or
// `packages/` is rewritten, so `agent.yaml` keeps the kits' own `cli:` and
// `mcp:` pins, and the hash in the lock is a hash of the kits' bytes plus two
// generated files that are a pure function of them.
//
// Usage:
//   node scripts/sync-kit-templates.mjs                     # re-sync at the locked ref
//   node scripts/sync-kit-templates.mjs --ref v0.2.0        # bump to a tag (or a sha)
//   node scripts/sync-kit-templates.mjs --check             # release gate: fetch the
//                                                           # locked ref, rebuild, compare
//   node scripts/sync-kit-templates.mjs --verify            # offline: packaged trees vs lock
//
// Exit codes: 0 = in sync, 1 = out of sync (or a sync that changed nothing
// under --check), 2 = the check itself could not run.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_FORMAT = 1;
export const DEFAULT_KITS_REPO = "https://github.com/codespar/agent-starter-kits";
export const LOCK_BASENAME = "kits.lock.json";

/**
 * The kits root files a standalone init needs, copied verbatim when present.
 * `.gitignore` travels as `_gitignore`: npm drops every `.gitignore` from a
 * tarball, whatever directory it sits in, and `init` renames it back. Without
 * it a scaffolded agent would commit `.env`, `runs/` and `.codespar/`, which
 * is where the signed mandate lives.
 */
export const ROOT_FILES_VERBATIM = [
  ["LICENSE", "LICENSE"],
  [".gitignore", "_gitignore"],
  ["tsconfig.base.json", "tsconfig.base.json"],
  ["vitest.config.ts", "vitest.config.ts"],
];
export const AGENT_CORE_DIR = "packages/agent-core";

const GENERATED_FILES = ["package.json", "README.md"];

export class SyncError extends Error {}

// ---------------------------------------------------------------------------
// Hashing — one stable fingerprint per template tree
// ---------------------------------------------------------------------------

/** sha256 per file under `dir`, keyed by POSIX-relative path; sorted. */
export function hashTree(dir) {
  const out = new Map();
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const rel = path.relative(dir, child).split(path.sep).join("/");
        out.set(rel, createHash("sha256").update(fs.readFileSync(child)).digest("hex"));
      }
    }
  };
  walk(dir);
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** `sha256:<hex>` over `<path>\0<sha256>\n` lines in path order. */
export function treeFingerprint(tree) {
  const h = createHash("sha256");
  for (const [file, sha] of tree) h.update(`${file}\0${sha}\n`);
  return `sha256:${h.digest("hex")}`;
}

export function fingerprintDir(dir) {
  return treeFingerprint(hashTree(dir));
}

/** Files that differ between two hashed trees, for the gate's report. */
export function diffTrees(expected, actual) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [file, sha] of actual) {
    const before = expected.get(file);
    if (before === undefined) added.push(file);
    else if (before !== sha) changed.push(file);
  }
  for (const file of expected.keys()) if (!actual.has(file)) removed.push(file);
  return { added, removed, changed, same: added.length + removed.length + changed.length === 0 };
}

// ---------------------------------------------------------------------------
// agent.yaml — the handful of top-level scalars this script needs. The CLI
// has no YAML dependency and the manifest's schema 1 keeps these at the top
// level as plain scalars, so a line parser is enough; anything nested is
// left to the agent's own `npm run check`.
// ---------------------------------------------------------------------------

export function parseManifestScalars(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].replace(/\s+#.*$/, "").trim();
    if (value === "" || value.startsWith("[") || value.startsWith("{")) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building one template from a checked-out kits tree
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function copyDirVerbatim(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      copyDirVerbatim(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/** Agents under `agents/*` that carry an agent.yaml. */
export function discoverAgents(kitsDir) {
  const root = path.join(kitsDir, "agents");
  if (!fs.existsSync(root)) throw new SyncError(`${kitsDir} has no agents/ directory — is this the kits repo?`);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "agent.yaml")))
    .map((e) => e.name)
    .sort();
}

/**
 * The root scripts of a template: the kits root's own `start`/`check`/
 * `test`/`typecheck`, narrowed to this one agent, plus a pass-through for
 * every other script the agent declares, so `npm run consent -- --yes` at
 * the template root reaches the agent exactly as it does in the kits repo.
 */
export function rootScriptsFor(agentName, agentScripts, kitsRootScripts) {
  const ws = `agents/${agentName}`;
  const scripts = {
    start: `npm start --workspace=${ws} --`,
    check: kitsRootScripts.check ?? "npm run check --workspaces --if-present --",
    test: kitsRootScripts.test ?? "vitest run --pool=forks --maxWorkers=1",
    typecheck: `tsc --noEmit -p ${AGENT_CORE_DIR}/tsconfig.json && tsc --noEmit -p ${ws}/tsconfig.json`,
  };
  for (const name of Object.keys(agentScripts).sort()) {
    if (name in scripts) continue;
    scripts[name] = `npm run ${name} --workspace=${ws} --`;
  }
  return scripts;
}

/** The lines `codespar init` prints after scaffolding this template. */
export function nextStepsFor(agentName, agentScripts) {
  const steps = [`cp agents/${agentName}/.env.example agents/${agentName}/.env   # then fill in your keys`, "npm install"];
  if ("consent" in agentScripts) steps.push("npm run consent -- --yes");
  steps.push("npm start");
  return steps;
}

function generatedPackageJson({ agentName, agentPkg, kitsRootPkg }) {
  const manifest = {
    name: "{{name}}",
    version: "0.1.0",
    private: true,
    description: agentPkg.description ?? "",
    license: kitsRootPkg.license ?? "MIT",
    type: "module",
    workspaces: [AGENT_CORE_DIR, `agents/${agentName}`],
    scripts: rootScriptsFor(agentName, agentPkg.scripts ?? {}, kitsRootPkg.scripts ?? {}),
    devDependencies: kitsRootPkg.devDependencies ?? {},
  };
  if (kitsRootPkg.engines) manifest.engines = kitsRootPkg.engines;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function generatedReadme({ agentName, agentPkg, agentManifest, commit, repo, coreVersion, steps }) {
  return [
    "# {{name}}",
    "",
    `Scaffolded by \`codespar init --template ${agentName}\` from the \`${agentName}\` starter kit`,
    `(${repo} at \`${commit}\`, agent ${agentManifest.version ?? agentPkg.version ?? "?"}).`,
    "",
    agentPkg.description ?? "",
    "",
    "`@codespar/agent-core` is not published on npm yet, so the copy this agent was built",
    `against (${coreVersion}) is vendored under \`${AGENT_CORE_DIR}/\` and linked as an npm workspace;`,
    "the agent's own `package.json` pin resolves to it unchanged.",
    "",
    "```",
    ...steps.map((s) => `  ${s}`),
    "```",
    "",
    `The agent's guide is [\`agents/${agentName}/README.md\`](agents/${agentName}/README.md); its commands run at this root`,
    `(\`npm run check\`, \`npm run eval\`, \`npm test\`) or inside \`agents/${agentName}/\`. The manifest pins`,
    `\`cli: "${agentManifest.cli ?? "?"}"\`, the CLI version whose \`agent run\`/\`eval\` this agent was written for.`,
    "",
  ].join("\n");
}

/**
 * Build `<outDir>` for one agent from a kits checkout. Pure function of the
 * checkout's bytes: the same commit builds the same tree, which is what lets
 * `--check` re-derive and compare.
 */
export function buildTemplate({ kitsDir, agentName, outDir, commit, repo = DEFAULT_KITS_REPO }) {
  const agentDir = path.join(kitsDir, "agents", agentName);
  const manifestFile = path.join(agentDir, "agent.yaml");
  if (!fs.existsSync(manifestFile)) throw new SyncError(`agents/${agentName}/agent.yaml not found in ${kitsDir}`);
  const coreDir = path.join(kitsDir, AGENT_CORE_DIR);
  if (!fs.existsSync(path.join(coreDir, "package.json"))) {
    throw new SyncError(`${AGENT_CORE_DIR}/package.json not found in ${kitsDir}`);
  }

  const agentManifest = parseManifestScalars(fs.readFileSync(manifestFile, "utf8"));
  if (agentManifest.schema !== "1") {
    throw new SyncError(`agents/${agentName}/agent.yaml declares schema ${agentManifest.schema ?? "(none)"}; this script knows schema 1`);
  }
  const agentPkg = readJson(path.join(agentDir, "package.json"));
  const corePkg = readJson(path.join(coreDir, "package.json"));
  const kitsRootPkg = readJson(path.join(kitsDir, "package.json"));

  const corePin = agentPkg.dependencies?.[corePkg.name];
  if (corePin !== corePkg.version) {
    throw new SyncError(
      `agents/${agentName} depends on ${corePkg.name}@${corePin ?? "(absent)"} but the kits tree carries ${corePkg.version}; the workspace link would not resolve`,
    );
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, packagedAs] of ROOT_FILES_VERBATIM) {
    const src = path.join(kitsDir, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, packagedAs));
  }
  copyDirVerbatim(coreDir, path.join(outDir, AGENT_CORE_DIR));
  copyDirVerbatim(agentDir, path.join(outDir, "agents", agentName));

  // `init` substitutes `{{name}}` in every file it copies. The generated files
  // carry it on purpose; a kit file carrying it would be rewritten at init
  // and the template would no longer be the kits' bytes.
  for (const [file] of hashTree(outDir)) {
    if (fs.readFileSync(path.join(outDir, file), "utf8").includes("{{name}}")) {
      throw new SyncError(`${file} in agents/${agentName} contains "{{name}}", which init would substitute`);
    }
  }

  const steps = nextStepsFor(agentName, agentPkg.scripts ?? {});
  fs.writeFileSync(path.join(outDir, "package.json"), generatedPackageJson({ agentName, agentPkg, kitsRootPkg }));
  fs.writeFileSync(
    path.join(outDir, "README.md"),
    generatedReadme({ agentName, agentPkg, agentManifest, commit, repo, coreVersion: corePkg.version, steps }),
  );

  return {
    source: `agents/${agentName}`,
    description: agentPkg.description ?? "",
    version: agentManifest.version ?? agentPkg.version ?? "",
    cli: agentManifest.cli ?? "",
    mcp: agentManifest.mcp ?? "",
    agent_core: corePkg.version,
    next_steps: steps,
    hash: fingerprintDir(outDir),
  };
}

// ---------------------------------------------------------------------------
// Fetching a kits ref
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Check out `ref` (tag, branch or commit) of `repo` into `into`, depth 1, and
 * return the commit it resolved to. Fetching by sha works against GitHub and
 * against a local repository path, which is what the tests use.
 */
export function fetchKits({ repo, ref, into }) {
  fs.mkdirSync(into, { recursive: true });
  try {
    git(["init", "-q"], into);
    git(["remote", "add", "origin", repo], into);
    git(["fetch", "-q", "--depth", "1", "origin", ref], into);
    git(["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], into);
    const commit = git(["rev-parse", "FETCH_HEAD"], into);
    fs.rmSync(path.join(into, ".git"), { recursive: true, force: true });
    return { commit };
  } catch (err) {
    throw new SyncError(`could not fetch ${ref} from ${repo}: ${err.stderr?.trim() || err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

export function readLock(file) {
  if (!fs.existsSync(file)) return null;
  const lock = JSON.parse(fs.readFileSync(file, "utf8"));
  if (lock.format !== LOCK_FORMAT) throw new SyncError(`${file} has format ${lock.format}; this script writes format ${LOCK_FORMAT}`);
  return lock;
}

export function writeLock(file, lock) {
  const ordered = {
    format: LOCK_FORMAT,
    kits_repo: lock.kits_repo,
    kits_ref: lock.kits_ref,
    commit: lock.commit,
    agent_core: lock.agent_core,
    templates: Object.fromEntries(Object.entries(lock.templates).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  fs.writeFileSync(file, `${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Sync every agent of `repo@ref` into `templatesDir` and write the lock.
 * Returns the lock. Nothing is written until every template built.
 */
export function syncKitTemplates({ repo, ref, templatesDir, lockFile = path.join(templatesDir, LOCK_BASENAME) }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kit-templates-"));
  try {
    const checkout = path.join(scratch, "kits");
    const { commit } = fetchKits({ repo, ref, into: checkout });
    const agents = discoverAgents(checkout);
    if (agents.length === 0) throw new SyncError(`${repo}@${ref} has no agents/*/agent.yaml`);

    const built = path.join(scratch, "templates");
    const templates = {};
    for (const name of agents) {
      templates[name] = buildTemplate({ kitsDir: checkout, agentName: name, outDir: path.join(built, name), commit, repo });
    }
    const coreVersion = readJson(path.join(checkout, AGENT_CORE_DIR, "package.json")).version;

    for (const name of agents) {
      const dst = path.join(templatesDir, name);
      fs.rmSync(dst, { recursive: true, force: true });
      copyDirVerbatim(path.join(built, name), dst);
    }
    const lock = {
      kits_repo: repo,
      kits_ref: ref,
      commit,
      agent_core: { source: AGENT_CORE_DIR, version: coreVersion },
      templates,
    };
    writeLock(lockFile, lock);
    return { lock, agents };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Offline half of the gate: every template the lock names is packaged and
 * hashes to what the lock says, and no template the lock does not name
 * carries a kits layout. No network.
 */
export function verifyPackaged({ templatesDir, lockFile = path.join(templatesDir, LOCK_BASENAME) }) {
  const lock = readLock(lockFile);
  if (!lock) return { ok: false, problems: [`${lockFile} is missing`] };
  const problems = [];
  for (const [name, entry] of Object.entries(lock.templates)) {
    const dir = path.join(templatesDir, name);
    if (!fs.existsSync(dir)) {
      problems.push(`templates/${name} is in the lock but not on disk`);
      continue;
    }
    const actual = fingerprintDir(dir);
    if (actual !== entry.hash) problems.push(`templates/${name} hashes to ${actual}, the lock says ${entry.hash}`);
  }
  return { ok: problems.length === 0, problems, lock };
}

/**
 * Online half of the gate: fetch the locked ref, rebuild every template in a
 * scratch dir and compare against BOTH the lock and the packaged trees. This
 * is what stops a release whose templates were hand-edited, whose lock was
 * edited by hand, or whose ref no longer resolves to the recorded commit.
 */
export function checkAgainstLock({ templatesDir, lockFile = path.join(templatesDir, LOCK_BASENAME) }) {
  const lock = readLock(lockFile);
  if (!lock) throw new SyncError(`${lockFile} is missing — run the sync once to create it`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kit-templates-check-"));
  const problems = [];
  try {
    const checkout = path.join(scratch, "kits");
    const { commit } = fetchKits({ repo: lock.kits_repo, ref: lock.kits_ref, into: checkout });
    if (commit !== lock.commit) {
      problems.push(`${lock.kits_ref} now resolves to ${commit}, the lock recorded ${lock.commit}`);
    }
    const agents = discoverAgents(checkout);
    const locked = Object.keys(lock.templates).sort();
    if (agents.join(",") !== locked.join(",")) {
      problems.push(`the kits ref carries agents [${agents.join(", ")}], the lock names [${locked.join(", ")}]`);
    }
    for (const name of agents) {
      if (!lock.templates[name]) continue;
      const rebuilt = path.join(scratch, "templates", name);
      const entry = buildTemplate({ kitsDir: checkout, agentName: name, outDir: rebuilt, commit: lock.commit, repo: lock.kits_repo });
      const packaged = path.join(templatesDir, name);
      if (!fs.existsSync(packaged)) {
        problems.push(`templates/${name} is not packaged`);
        continue;
      }
      const diff = diffTrees(hashTree(rebuilt), hashTree(packaged));
      if (!diff.same) {
        problems.push(
          `templates/${name} differs from a fresh sync of ${lock.kits_ref}:` +
            diff.changed.map((f) => `\n    changed  ${f}`).join("") +
            diff.added.map((f) => `\n    extra    ${f}`).join("") +
            diff.removed.map((f) => `\n    missing  ${f}`).join(""),
        );
      }
      if (entry.hash !== lock.templates[name].hash) {
        problems.push(`templates/${name}: a fresh sync hashes to ${entry.hash}, the lock says ${lock.templates[name].hash}`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { ok: problems.length === 0, problems, lock };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { ref: null, repo: null, check: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ref") out.ref = argv[++i];
    else if (a.startsWith("--ref=")) out.ref = a.slice(6);
    else if (a === "--repo") out.repo = argv[++i];
    else if (a.startsWith("--repo=")) out.repo = a.slice(7);
    else if (a === "--check") out.check = true;
    else if (a === "--verify") out.verify = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new SyncError(`unknown argument ${a}`);
  }
  return out;
}

function report(problems) {
  for (const p of problems) console.error(`✗ ${p}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: sync-kit-templates.mjs [--ref <tag|sha>] [--repo <url|path>] [--check | --verify]");
    return 0;
  }
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const templatesDir = path.join(packageDir, "templates");
  const lockFile = path.join(templatesDir, LOCK_BASENAME);

  if (args.verify) {
    const r = verifyPackaged({ templatesDir, lockFile });
    if (!r.ok) {
      report(r.problems);
      console.error("::error::packaged kit templates do not match templates/kits.lock.json — run `npm run sync:kit-templates` and commit");
      return 1;
    }
    console.log(`✓ ${Object.keys(r.lock.templates).length} kit template(s) match the lock (${r.lock.kits_ref})`);
    return 0;
  }

  if (args.check) {
    const r = checkAgainstLock({ templatesDir, lockFile });
    if (!r.ok) {
      report(r.problems);
      console.error(
        `::error::kit templates are out of sync with ${r.lock.kits_repo}@${r.lock.kits_ref} — run \`npm run sync:kit-templates\` in packages/cli and commit the result`,
      );
      return 1;
    }
    console.log(`✓ kit templates are a faithful sync of ${r.lock.kits_repo}@${r.lock.kits_ref} (${r.lock.commit})`);
    return 0;
  }

  const existing = readLock(lockFile);
  const repo = args.repo ?? existing?.kits_repo ?? DEFAULT_KITS_REPO;
  const ref = args.ref ?? existing?.kits_ref;
  if (!ref) throw new SyncError("no --ref given and no kits.lock.json to read one from");
  const { lock, agents } = syncKitTemplates({ repo, ref, templatesDir, lockFile });
  console.log(`✓ synced ${agents.length} template(s) from ${repo}@${ref} (${lock.commit}):`);
  for (const [name, entry] of Object.entries(lock.templates)) console.log(`    ${name}  ${entry.version}  ${entry.hash.slice(0, 19)}…`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`::error::${err instanceof SyncError ? err.message : err.stack ?? err.message}`);
    process.exit(2);
  }
}
