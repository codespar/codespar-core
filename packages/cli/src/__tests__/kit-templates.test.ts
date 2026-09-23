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
  buildTemplate,
  checkAgainstLock,
  diffTrees,
  fingerprintDir,
  hashTree,
  nextStepsFor,
  parseManifestScalars,
  readLock,
  rootScriptsFor,
  syncKitTemplates,
  treeFingerprint,
  verifyPackaged,
  LOCK_BASENAME,
} from "../../scripts/sync-kit-templates.mjs";
import { listTemplates, loadKitTemplates } from "../commands/init.js";

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
    expect(scripts.check).toBe("npm run check --workspaces --if-present --");
    expect(scripts.test).toBe("vitest run");
    expect(scripts.typecheck).toContain("agents/demo-agent/tsconfig.json");
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
      agent_core: "0.1.0",
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

describe("syncKitTemplates + the release gate, against a local kits repository", () => {
  it("syncs a tag, records the commit it resolved to, and both halves of the gate pass", () => {
    const { dir, commit } = fixtureKits();
    const templatesDir = scratch("templates-");

    const { lock, agents } = syncKitTemplates({ repo: dir, ref: "v0.1.0", templatesDir });
    expect(agents).toEqual(["demo-agent"]);
    expect(lock.kits_ref).toBe("v0.1.0");
    expect(lock.commit).toBe(commit);
    expect(lock.agent_core).toEqual({ source: "packages/agent-core", version: "0.1.0" });

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

  it("ships bills-agent and collections-agent, pinned to one kits commit, with the kits' own cli pin untouched", () => {
    const lock = readLock(join(TEMPLATES_DIR, LOCK_BASENAME));
    expect(Object.keys(lock.templates)).toEqual(["bills-agent", "collections-agent"]);
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.kits_repo).toBe("https://github.com/codespar/agent-starter-kits");
    for (const slug of Object.keys(lock.templates)) {
      const root = join(TEMPLATES_DIR, slug);
      const manifest = parseManifestScalars(readFileSync(join(root, "agents", slug, "agent.yaml"), "utf8"));
      expect(manifest.schema).toBe("1");
      expect(manifest.cli).toBe(lock.templates[slug].cli);
      expect(manifest.cli).toMatch(/^@codespar\/cli@\d+\.\d+\.\d+$/);
      expect(existsSync(join(root, "_gitignore"))).toBe(true);
      expect(existsSync(join(root, "packages/agent-core/package.json"))).toBe(true);
      expect(existsSync(join(root, "agents", slug, ".env.example"))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      expect(pkg.workspaces).toEqual(["packages/agent-core", `agents/${slug}`]);
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
    expect(kits.map((t) => t.slug)).toEqual(["bills-agent", "collections-agent"]);
    for (const t of kits) {
      expect(t.kind).toBe("kit");
      expect(t.description).toBe(lock.templates[t.slug].description);
      expect(t.description.split("\n")).toHaveLength(1);
      expect(t.nextSteps).toEqual(lock.templates[t.slug].next_steps);
      expect(t.framework).toContain(lock.commit.slice(0, 7));
    }
  });

  it("a package without the lock has no kit templates and still lists the framework ones", () => {
    const empty = scratch("no-lock-");
    expect(loadKitTemplates(empty)).toEqual([]);
    expect(listTemplates(empty).map((t) => t.slug)).toEqual(["pix-agent", "ecommerce-checkout", "streaming-chat", "multi-tenant"]);
  });
});
