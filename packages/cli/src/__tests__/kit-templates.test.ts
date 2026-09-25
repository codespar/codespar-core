/**
 * The starter-kit templates: the lock, the hash, the sync against a kits
 * repository and the two halves of the release gate.
 *
 * Everything here runs without the network. The sync is exercised against a
 * kits repository built in a temp dir and committed with git, which is the
 * same code path a GitHub ref takes (`git fetch --depth 1 origin <ref>`).
 * The packaged `templates/` tree is checked against `templates/kits.lock.json`
 * on every run: that is the offline half of "template desatualizado reprova
 * o release", and the online half (`--check`) is the same comparison after a
 * fresh fetch of the locked ref.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  assertLocalDepsVendored,
  buildTemplate,
  checkAgainstLock,
  diffTrees,
  discoverKitsPackages,
  vendoredPackagesFor,
  fingerprintDir,
  hashTree,
  nextStepsFor,
  parseManifestScalars,
  readLock,
  renderKitTemplateRows,
  rootScriptsFor,
  syncKitTemplates,
  treeFingerprint,
  updateReadmeKitRows,
  verifyPackaged,
  LOCK_BASENAME,
  README_BLOCK_END,
  README_BLOCK_START,
} from "../../scripts/sync-kit-templates.mjs";
import { listTemplates, loadKitTemplates, templateOptionHelp } from "../commands/init.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = join(HERE, "../..");
const TEMPLATES_DIR = join(PACKAGE_DIR, "templates");

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "kits",
      GIT_AUTHOR_EMAIL: "kits@example.invalid",
      GIT_COMMITTER_NAME: "kits",
      GIT_COMMITTER_EMAIL: "kits@example.invalid",
    },
  }).trim();
}

/** A kits repository with the shape the sync reads: one agent, the core, the root files. */
function fixtureKits(): { dir: string; commit: string } {
  const dir = scratch("kits-fixture-");
  write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "agent-starter-kits",
        private: true,
        license: "MIT",
        type: "module",
        workspaces: ["packages/*", "agents/*"],
        engines: { node: ">=22.13" },
        scripts: {
          start: "npm start --workspace=agents/demo-agent --",
          check: "npm run check --workspaces --if-present --",
          test: "vitest run --pool=forks --maxWorkers=1",
          typecheck: "tsc --noEmit -p packages/agent-core/tsconfig.json",
        },
        devDependencies: { tsx: "4.20.5", typescript: "5.9.2", vitest: "3.2.4", "@types/node": "22.20.4" },
      },
      null,
      2,
    ),
  );
  write(dir, "LICENSE", "MIT\n");
  write(dir, ".gitignore", "node_modules/\n.codespar/\nruns/\n.env\n.env.*\n!.env.example\n");
  write(dir, "tsconfig.base.json", '{ "compilerOptions": { "strict": true } }\n');
  write(dir, "vitest.config.ts", "export default {};\n");
  write(
    dir,
    "packages/agent-core/package.json",
    JSON.stringify({ name: "@codespar/agent-core", version: "0.1.0", type: "module", main: "./src/index.ts" }, null, 2),
  );
  write(dir, "packages/agent-core/src/index.ts", "export const core = true;\n");
  write(
    dir,
    "agents/demo-agent/agent.yaml",
    [
      "# a comment line",
      "schema: 1",
      "name: demo-agent",
      "version: 0.1.0",
      "approval: [human, mandate]",
      'cli: "@codespar/cli@0.13.0"    # pinned by the kit',
      'mcp: "@codespar/mcp@0.5.8"',
      "tools: ./tools.json",
      "",
    ].join("\n"),
  );
  write(
    dir,
    "agents/demo-agent/package.json",
    JSON.stringify(
      {
        name: "@codespar/demo-agent",
        version: "0.1.0",
        private: true,
        description: "A demo agent for the sync test.",
        type: "module",
        scripts: { start: "node src/main.js", check: "node src/check.js", consent: "node src/consent.js", eval: "node src/eval.js" },
        dependencies: { "@codespar/agent-core": "0.1.0" },
      },
      null,
      2,
    ),
  );
  write(dir, "agents/demo-agent/src/main.ts", 'console.log("demo");\n');
  write(dir, "agents/demo-agent/.env.example", "CODESPAR_API_KEY=csk_test_your_key_here\n");
  write(dir, "agents/demo-agent/README.md", "# demo-agent\n");
  git(dir, "init", "-q");
  // The default branch name is the runner's (`master` on GitHub's image,
  // `main` on a developer's machine with init.defaultBranch set). The test
  // that syncs a branch names `main`, so the fixture fixes it here.
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "kits fixture");
  // A commit on top with a different agent version and a tag on the first,
  // so the test can tell "the ref" from "the branch head".
  const commit = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "v0.1.0");
  return { dir, commit };
}

describe("hashTree / treeFingerprint", () => {
  it("is a function of paths and bytes only, in a stable order", () => {
    const a = scratch("hash-a-");
    const b = scratch("hash-b-");
    write(a, "z/last.txt", "1");
    write(a, "first.txt", "2");
    write(b, "first.txt", "2");
    write(b, "z/last.txt", "1");
    expect(fingerprintDir(a)).toBe(fingerprintDir(b));
    expect(fingerprintDir(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect([...hashTree(a).keys()]).toEqual(["first.txt", "z/last.txt"]);
  });

  it("changes on a byte, on a rename and on an added file", () => {
    const a = scratch("hash-c-");
    write(a, "x.txt", "same");
    const before = fingerprintDir(a);
    write(a, "x.txt", "SAME");
    const changedByte = fingerprintDir(a);
    expect(changedByte).not.toBe(before);
    write(a, "x.txt", "same");
    expect(fingerprintDir(a)).toBe(before);
    write(a, "y.txt", "");
    expect(fingerprintDir(a)).not.toBe(before);
  });

  it("diffTrees names what moved", () => {
    const expected = new Map([
      ["a", "1"],
      ["b", "2"],
    ]);
    const actual = new Map([
      ["a", "1"],
      ["b", "3"],
      ["c", "4"],
    ]);
    expect(diffTrees(expected, actual)).toEqual({ added: ["c"], removed: [], changed: ["b"], same: false });
    expect(diffTrees(expected, expected).same).toBe(true);
    expect(treeFingerprint(expected)).not.toBe(treeFingerprint(actual));
  });
});

describe("parseManifestScalars", () => {
  it("reads the top-level scalars of an agent.yaml and skips lists, comments and blanks", () => {
    const m = parseManifestScalars(
      ['schema: 1', "name: bills-agent", "version: 0.1.0", "approval: [human, mandate]", "escalate_above:", "  amount: 150000", 'cli: "@codespar/cli@0.13.0"    # what npm publishes', "channels: [terminal]"].join("\n"),
    );
    expect(m).toEqual({ schema: "1", name: "bills-agent", version: "0.1.0", cli: "@codespar/cli@0.13.0" });
  });
});

describe("the generated root of a template", () => {
  it("narrows the kits root scripts to the one agent and passes the agent's other scripts through", () => {
    const scripts = rootScriptsFor("demo-agent", { start: "x", check: "y", consent: "z", eval: "w", typecheck: "t", test: "u" }, { check: "npm run check --workspaces --if-present --", test: "vitest run" });
    expect(scripts.start).toBe("npm start --workspace=agents/demo-agent --");
    expect(scripts.consent).toBe("npm run consent --workspace=agents/demo-agent --");
    expect(scripts.eval).toBe("npm run eval --workspace=agents/demo-agent --");
    expect(scripts.test).toBe("vitest run");
    expect(scripts.typecheck).toContain("agents/demo-agent/tsconfig.json");
  });

  it("does NOT copy the kits root's own check, which runs repo-level gates a template has no files for", () => {
    // 25/09: the kits root check became
    // `node scripts/check-plugin.mjs && npm run check --workspaces …`, and
    // `scripts/` is not copied into a template, so a scaffold's `npm run check`
    // died on the missing file before reaching the agent. The e2e gate caught
    // it; this keeps it caught.
    const scripts = rootScriptsFor(
      "demo-agent",
      { check: "codespar-agent check" },
      { check: "node scripts/check-plugin.mjs && npm run check --workspaces --if-present --" },
    );
    expect(scripts.check).toBe("npm run check --workspaces --if-present --");
    expect(scripts.check).not.toContain("scripts/");
  });

  it("prints the consent step only for an agent that has a consent script", () => {
    expect(nextStepsFor("bills-agent", { consent: "x" })).toEqual([
      "cp agents/bills-agent/.env.example agents/bills-agent/.env   # then fill in your keys",
      "npm install",
      "npm run consent -- --yes",
      "npm start",
    ]);
    expect(nextStepsFor("collections-agent", {})).not.toContain("npm run consent -- --yes");
  });
});

describe("buildTemplate", () => {
  it("copies the agent and the core verbatim, the root files by name, and refuses what init would rewrite", () => {
    const { dir, commit } = fixtureKits();
    const out = scratch("built-");
    const entry = buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit, repo: "file://kits" });

    expect(readFileSync(join(out, "agents/demo-agent/agent.yaml"), "utf8")).toBe(readFileSync(join(dir, "agents/demo-agent/agent.yaml"), "utf8"));
    expect(readFileSync(join(out, "packages/agent-core/src/index.ts"), "utf8")).toBe("export const core = true;\n");
    expect(existsSync(join(out, "_gitignore"))).toBe(true);
    expect(existsSync(join(out, ".gitignore"))).toBe(false);
    expect(existsSync(join(out, "LICENSE"))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.name).toBe("{{name}}");
    expect(pkg.workspaces).toEqual(["packages/agent-core", "agents/demo-agent"]);
    expect(pkg.devDependencies).toEqual({ tsx: "4.20.5", typescript: "5.9.2", vitest: "3.2.4", "@types/node": "22.20.4" });
    expect(pkg.engines).toEqual({ node: ">=22.13" });
    expect(pkg.scripts.consent).toBe("npm run consent --workspace=agents/demo-agent --");

    expect(readFileSync(join(out, "README.md"), "utf8")).toContain(commit);
    expect(entry).toMatchObject({
      source: "agents/demo-agent",
      description: "A demo agent for the sync test.",
      version: "0.1.0",
      cli: "@codespar/cli@0.13.0",
      vendored: { "@codespar/agent-core": "0.1.0" },
      next_steps: ["cp agents/demo-agent/.env.example agents/demo-agent/.env   # then fill in your keys", "npm install", "npm run consent -- --yes", "npm start"],
    });
    expect(entry.hash).toBe(fingerprintDir(out));

    // Deterministic: the same checkout builds the same bytes.
    const again = scratch("built-again-");
    expect(buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: again, commit, repo: "file://kits" }).hash).toBe(entry.hash);
  });

  it("refuses a kit file carrying {{name}}, a manifest of another schema, and a core pin that would not link", () => {
    const { dir, commit } = fixtureKits();
    const out = scratch("built-refuse-");

    write(dir, "agents/demo-agent/SYSTEM_PROMPT.md", "You are {{name}}.\n");
    expect(() => buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit })).toThrow(/SYSTEM_PROMPT\.md.*\{\{name\}\}/);
    rmSync(join(dir, "agents/demo-agent/SYSTEM_PROMPT.md"));

    const manifest = readFileSync(join(dir, "agents/demo-agent/agent.yaml"), "utf8");
    write(dir, "agents/demo-agent/agent.yaml", manifest.replace("schema: 1", "schema: 2"));
    expect(() => buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit })).toThrow(/schema 2/);
    write(dir, "agents/demo-agent/agent.yaml", manifest);

    const pkgFile = join(dir, "agents/demo-agent/package.json");
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    pkg.dependencies["@codespar/agent-core"] = "0.2.0";
    writeFileSync(pkgFile, JSON.stringify(pkg));
    expect(() => buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit })).toThrow(/0\.2\.0.*0\.1\.0/);
  });
});

/**
 * Adds a second kits-local package to a fixture and points the agent at it:
 * `agents/demo-agent` -> `@codespar/agent-runtime` -> `@codespar/agent-core`,
 * which is the shape kits `8f130b7` introduced when it split the shared runner
 * out of the core. The runtime owns the `codespar-agent` bin, so it is what the
 * agent's scripts actually call.
 */
function addRuntimePackage(dir: string, opts: { corePin?: string } = {}): void {
  write(
    dir,
    "packages/agent-runtime/package.json",
    JSON.stringify(
      {
        name: "@codespar/agent-runtime",
        version: "0.1.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        bin: { "codespar-agent": "./bin.mjs" },
        dependencies: { "@codespar/agent-core": opts.corePin ?? "0.1.0" },
      },
      null,
      2,
    ),
  );
  write(dir, "packages/agent-runtime/src/index.ts", "export const runtime = true;\n");
  write(dir, "packages/agent-runtime/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }\n');
  write(dir, "packages/agent-runtime/bin.mjs", "#!/usr/bin/env node\n");
  const pkgFile = join(dir, "agents/demo-agent/package.json");
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  pkg.dependencies["@codespar/agent-runtime"] = "0.1.0";
  pkg.scripts.check = "codespar-agent check";
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
}

describe("vendoring the kits' own packages", () => {
  it("walks the agent's local dependencies transitively and vendors every one", () => {
    const { dir, commit } = fixtureKits();
    addRuntimePackage(dir);
    write(dir, "packages/agent-core/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }\n');
    const out = scratch("built-split-");

    const kitsPackages = discoverKitsPackages(dir);
    expect([...kitsPackages.keys()].sort()).toEqual(["@codespar/agent-core", "@codespar/agent-runtime"]);

    // The agent names only the runtime's sibling directly; the core arrives
    // because the runtime depends on it.
    const chosen = vendoredPackagesFor({
      agentName: "demo-agent",
      agentPkg: JSON.parse(readFileSync(join(dir, "agents/demo-agent/package.json"), "utf8")),
      kitsPackages,
    });
    expect(chosen.map((p) => p.source)).toEqual(["packages/agent-core", "packages/agent-runtime"]);

    const entry = buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit, repo: "file://kits" });
    expect(existsSync(join(out, "packages/agent-runtime/bin.mjs"))).toBe(true);
    expect(existsSync(join(out, "packages/agent-core/src/index.ts"))).toBe(true);
    expect(entry.vendored).toEqual({ "@codespar/agent-core": "0.1.0", "@codespar/agent-runtime": "0.1.0" });

    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(pkg.workspaces).toEqual(["packages/agent-core", "packages/agent-runtime", "agents/demo-agent"]);
    // The runtime is typechecked too. Vendoring code the root never looks at
    // is how a green `npm run typecheck` stops meaning anything.
    expect(pkg.scripts.typecheck).toBe(
      "tsc --noEmit -p packages/agent-core/tsconfig.json && tsc --noEmit -p packages/agent-runtime/tsconfig.json && tsc --noEmit -p agents/demo-agent/tsconfig.json",
    );
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("`packages/agent-runtime/` — @codespar/agent-runtime 0.1.0");
  });

  it("refuses a pin that disagrees on a TRANSITIVE package, not just on the one the agent names", () => {
    const { dir, commit } = fixtureKits();
    addRuntimePackage(dir, { corePin: "0.9.0" });
    const out = scratch("built-split-pin-");
    expect(() => buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit })).toThrow(
      /packages\/agent-runtime depends on @codespar\/agent-core@0\.9\.0 but the kits tree carries 0\.1\.0/,
    );
  });

  it("CONTROL: the completeness guard refuses a tree that names a local package it does not carry", () => {
    // The defect of 25/09, planted. Before this guard, `buildTemplate` vendored
    // one hard-coded directory and returned SUCCESS for a template whose
    // `npm install` dies with `404 @codespar/agent-runtime`, because that
    // package is `private: true` and was never published. The guard is normally
    // satisfied by the closure walk, so the only way to watch it refuse is to
    // hand it the incomplete list a pre-fix build would have produced.
    const { dir, commit } = fixtureKits();
    addRuntimePackage(dir);
    const out = scratch("built-split-guard-");
    buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit });

    const kitsPackages = discoverKitsPackages(dir);
    const coreOnly = [{ name: "@codespar/agent-core", source: "packages/agent-core", version: "0.1.0" }];
    expect(() => assertLocalDepsVendored({ outDir: out, agentName: "demo-agent", kitsPackages, vendored: coreOnly })).toThrow(
      /agents\/demo-agent depends on @codespar\/agent-runtime.*does not vendor.*not published/s,
    );

    // And it passes on the tree the build actually produced, so the refusal
    // above is about the missing package and not about the walk being broken.
    expect(() =>
      assertLocalDepsVendored({
        outDir: out,
        agentName: "demo-agent",
        kitsPackages,
        vendored: [...kitsPackages.values()].map((p) => ({ name: p.name, source: p.source, version: p.version })),
      }),
    ).not.toThrow();
  });

  it("a single-package kit still builds: the list is derived, so one package is not a special case", () => {
    const { dir, commit } = fixtureKits();
    const out = scratch("built-single-");
    const entry = buildTemplate({ kitsDir: dir, agentName: "demo-agent", outDir: out, commit });
    expect(entry.vendored).toEqual({ "@codespar/agent-core": "0.1.0" });
    expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8")).workspaces).toEqual([
      "packages/agent-core",
      "agents/demo-agent",
    ]);
  });
});

describe("syncKitTemplates + the release gate, against a local kits repository", () => {
  it("syncs a tag, records the commit it resolved to, and both halves of the gate pass", () => {
    const { dir, commit } = fixtureKits();
    const templatesDir = scratch("templates-");

    const { lock, agents } = syncKitTemplates({ repo: dir, ref: "v0.1.0", templatesDir });
    expect(agents).toEqual(["demo-agent"]);
    expect(lock.kits_ref).toBe("v0.1.0");
    expect(lock.commit).toBe(commit);
    expect(lock.vendored_packages).toEqual([{ name: "@codespar/agent-core", source: "packages/agent-core", version: "0.1.0" }]);

    const onDisk = readLock(join(templatesDir, LOCK_BASENAME));
    expect(onDisk.format).toBe(1);
    expect(onDisk.templates["demo-agent"].hash).toBe(fingerprintDir(join(templatesDir, "demo-agent")));

    expect(verifyPackaged({ templatesDir })).toMatchObject({ ok: true, problems: [] });
    expect(checkAgainstLock({ templatesDir })).toMatchObject({ ok: true, problems: [] });
  });

  it("a sha is a ref too", () => {
    const { dir, commit } = fixtureKits();
    const templatesDir = scratch("templates-sha-");
    const { lock } = syncKitTemplates({ repo: dir, ref: commit, templatesDir });
    expect(lock.kits_ref).toBe(commit);
    expect(lock.commit).toBe(commit);
  });

  it("a hand-edited template fails the offline verify and the online check names the file", () => {
    const { dir } = fixtureKits();
    const templatesDir = scratch("templates-edited-");
    syncKitTemplates({ repo: dir, ref: "v0.1.0", templatesDir });

    write(templatesDir, "demo-agent/agents/demo-agent/src/main.ts", 'console.log("edited by hand");\n');
    const offline = verifyPackaged({ templatesDir });
    expect(offline.ok).toBe(false);
    expect(offline.problems.join("\n")).toMatch(/templates\/demo-agent hashes to sha256:/);

    const online = checkAgainstLock({ templatesDir });
    expect(online.ok).toBe(false);
    expect(online.problems.join("\n")).toContain("changed  agents/demo-agent/src/main.ts");
  });

  it("a moved ref (the kits advanced, the lock did not) fails the online check", () => {
    const { dir } = fixtureKits();
    const templatesDir = scratch("templates-moved-");
    // Sync at the branch name, then advance the branch: the lock still says the old commit.
    syncKitTemplates({ repo: dir, ref: "main", templatesDir });
    write(dir, "agents/demo-agent/src/main.ts", 'console.log("v2");\n');
    git(dir, "commit", "-q", "-am", "advance");

    const r = checkAgainstLock({ templatesDir });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/now resolves to [0-9a-f]{40}, the lock recorded/);
    expect(r.problems.join("\n")).toContain("changed  agents/demo-agent/src/main.ts");
  });

  it("an edited lock fails: the packaged tree no longer hashes to it", () => {
    const { dir } = fixtureKits();
    const templatesDir = scratch("templates-lock-");
    syncKitTemplates({ repo: dir, ref: "v0.1.0", templatesDir });
    const lockFile = join(templatesDir, LOCK_BASENAME);
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    lock.templates["demo-agent"].hash = "sha256:" + "0".repeat(64);
    writeFileSync(lockFile, JSON.stringify(lock));
    expect(verifyPackaged({ templatesDir }).ok).toBe(false);
    expect(checkAgainstLock({ templatesDir }).problems.join("\n")).toContain("a fresh sync hashes to");
  });
});

describe("the packaged kit templates (offline half of the release gate)", () => {
  it("every template the lock names is on disk and hashes to what the lock says", () => {
    const r = verifyPackaged({ templatesDir: TEMPLATES_DIR });
    expect(r.problems, "run `npm run sync:kit-templates` in packages/cli and commit the result").toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("ships every kit the lock names, pinned to one commit, with the cli pin untouched and every vendored package on disk", () => {
    const lock = readLock(join(TEMPLATES_DIR, LOCK_BASENAME));
    // Which agents exist is the kits repo's decision, so it is read rather
    // than spelled out: a list written here goes stale on the next agent that
    // lands, which is the whole reason the sync discovers them.
    expect(Object.keys(lock.templates).length).toBeGreaterThanOrEqual(2);
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.kits_repo).toBe("https://github.com/codespar/agent-starter-kits");

    for (const slug of Object.keys(lock.templates)) {
      const root = join(TEMPLATES_DIR, slug);
      const manifest = parseManifestScalars(readFileSync(join(root, "agents", slug, "agent.yaml"), "utf8"));
      expect(manifest.schema).toBe("1");
      expect(manifest.cli).toBe(lock.templates[slug].cli);
      expect(manifest.cli).toMatch(/^@codespar\/cli@\d+\.\d+\.\d+$/);
      expect(existsSync(join(root, "_gitignore"))).toBe(true);
      expect(existsSync(join(root, "agents", slug, ".env.example"))).toBe(true);

      // The packaged half of the completeness guard: every package this
      // template's lock entry says it vendors has a directory behind it and is
      // a workspace. A pin with no directory sends `npm install` to the
      // registry for a package that was never published there.
      const vendored = Object.keys(lock.templates[slug].vendored);
      expect(vendored.length).toBeGreaterThan(0);
      const sources = vendored.map((name) => {
        const entry = lock.vendored_packages.find((p: { name: string }) => p.name === name);
        expect(entry, `${name} is in ${slug}'s vendored map and not in vendored_packages`).toBeDefined();
        return entry.source as string;
      });
      for (const source of sources) {
        expect(existsSync(join(root, source, "package.json")), `${slug} does not carry ${source}`).toBe(true);
      }
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(pkg.workspaces).toEqual([...sources.sort(), `agents/${slug}`]);

      // And every kits-local pin the agent declares is one of them, at the
      // version the lock recorded.
      const agentPkg = JSON.parse(readFileSync(join(root, "agents", slug, "package.json"), "utf8"));
      for (const [dep, pin] of Object.entries<string>(agentPkg.dependencies ?? {})) {
        if (!dep.startsWith("@codespar/agent-")) continue;
        expect(vendored, `${slug} pins ${dep} but vendors only ${vendored.join(", ")}`).toContain(dep);
        expect(pin).toBe(lock.templates[slug].vendored[dep]);
      }
    }
  });

  it("the tarball carries the templates directory", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    expect(pkg.files).toContain("templates");
  });
});

describe("the template listing", () => {
  it("keeps the four framework templates first and adds each kit with its one-line description", () => {
    const all = listTemplates(TEMPLATES_DIR);
    expect(all.slice(0, 4).map((t) => t.slug)).toEqual(["pix-agent", "ecommerce-checkout", "streaming-chat", "multi-tenant"]);
    expect(all.slice(0, 4).every((t) => t.kind === "framework")).toBe(true);

    const lock = readLock(join(TEMPLATES_DIR, LOCK_BASENAME));
    const kits = all.slice(4);
    // Read from the lock, sorted, rather than named here.
    expect(kits.map((t) => t.slug)).toEqual(Object.keys(lock.templates).sort());
    for (const t of kits) {
      expect(t.kind).toBe("kit");
      expect(t.description).toBe(lock.templates[t.slug].description);
      expect(t.description.split("\n")).toHaveLength(1);
      expect(t.nextSteps).toEqual(lock.templates[t.slug].next_steps);
      expect(t.framework).toContain(lock.commit.slice(0, 7));
    }
  });

  it("the --template help names every template with its description, and never throws", () => {
    const help = templateOptionHelp(TEMPLATES_DIR);
    for (const t of listTemplates(TEMPLATES_DIR)) {
      expect(help, `${t.slug} is missing from the --template help`).toContain(t.slug);
      expect(help).toContain(t.description);
    }

    // CONTROL: this text is built while commander is being assembled, before a
    // command is chosen, so a broken lock must not take the whole CLI down with
    // it. A generic line is a worse help text; a stack trace on `codespar
    // login` is a broken CLI.
    const broken = scratch("templates-broken-");
    writeFileSync(join(broken, LOCK_BASENAME), "{ not json");
    expect(() => loadKitTemplates(broken)).toThrow();
    const fallback = templateOptionHelp(broken);
    expect(fallback).toContain("--list");
    expect(fallback.split("\n")).toHaveLength(1);
  });

  it("the README's kit rows are the lock's, so the table cannot drift from the templates", () => {
    const lock = readLock(join(TEMPLATES_DIR, LOCK_BASENAME));
    const readme = readFileSync(join(PACKAGE_DIR, "README.md"), "utf8");
    const start = readme.indexOf(README_BLOCK_START);
    const end = readme.indexOf(README_BLOCK_END);
    expect(start, `README.md has no ${README_BLOCK_START}`).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = readme.slice(start + README_BLOCK_START.length, end).trim();
    expect(block, "run `npm run sync:kit-templates` in packages/cli and commit the README too").toBe(
      renderKitTemplateRows(lock.templates),
    );
  });

  it("updateReadmeKitRows rewrites only the marked block, and refuses a file without one", () => {
    const dir = scratch("readme-");
    const file = join(dir, "README.md");
    const templates = { "z-agent": { description: "Zed." }, "a-agent": { description: "Ay." } };

    writeFileSync(file, `before\n${README_BLOCK_START}\n| old | row |\n${README_BLOCK_END}\nafter\n`);
    expect(updateReadmeKitRows(file, templates)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(
      `before\n${README_BLOCK_START}\n| \`a-agent\` | Starter kit — Ay. |\n| \`z-agent\` | Starter kit — Zed. |\n${README_BLOCK_END}\nafter\n`,
    );
    // Idempotent: a second run changes nothing and says so.
    expect(updateReadmeKitRows(file, templates)).toBe(false);

    writeFileSync(file, "no markers here\n");
    expect(() => updateReadmeKitRows(file, templates)).toThrow(/has no <!-- kit-templates:start -->/);

    // No README at all is not an error: the sync tests write into a scratch
    // directory with no package around it.
    expect(updateReadmeKitRows(join(dir, "absent.md"), templates)).toBe(false);
  });

  it("a package without the lock has no kit templates and still lists the framework ones", () => {
    const empty = scratch("no-lock-");
    expect(loadKitTemplates(empty)).toEqual([]);
    expect(listTemplates(empty).map((t) => t.slug)).toEqual(["pix-agent", "ecommerce-checkout", "streaming-chat", "multi-tenant"]);
  });
});
