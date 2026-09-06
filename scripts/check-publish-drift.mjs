#!/usr/bin/env node
// check-publish-drift.mjs — refuse the state that produced core#129:
// a package whose content changed while its version number did not.
//
// npm versions are immutable. Once @codespar/types@0.10.15 is on the
// registry, that specifier resolves to whatever was published under it,
// forever. When main's content moves on without a bump, every consumer
// installing that specifier gets the old artifact and no correction is
// possible at that number. core#129: main carried 15 meta-tool
// definitions, the published 0.10.15 tarball carried 3, for two months,
// with CI green the whole time.
//
// The rule this enforces, per publishable workspace package:
//
//   if the declared version already exists on the registry,
//   then the packed content must be identical to what was published
//   under that version — otherwise the version must be bumped.
//
// A version that is NOT yet on the registry is the healthy state: a bump
// is pending and whatever content rides it will be what consumers get.
// A package nobody touched packs identically and stays silent.
//
// Why compare content and not just "did this PR touch the package": the
// drift that produced core#129 was two months old by the time anyone
// looked. A guard keyed on the current diff would have passed every PR
// after the one that caused it. Comparing against the registry means the
// check answers the question that actually matters — is what consumers
// can install the same as what main would ship — no matter how long ago
// the divergence was introduced.
//
// Usage:
//   node scripts/check-publish-drift.mjs            # all packages
//   node scripts/check-publish-drift.mjs --only @codespar/types
//   node scripts/check-publish-drift.mjs --json
//
// Requires the workspace to be built first (`npx turbo run build`) —
// `npm pack` ships dist/, so an unbuilt tree cannot be compared. The
// script fails loudly rather than skipping when it cannot pack.
//
// Exit codes: 0 = no drift, 1 = drift found, 2 = the check itself could
// not run (network, pack failure). 2 is never treated as a pass; an
// unanswerable question is not a clean bill of health.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org";

// ---------------------------------------------------------------------------
// Pure comparison — no network, no npm. This is the part the self-test
// drives directly.
// ---------------------------------------------------------------------------

/** sha256 of every file under `dir`, keyed by path relative to `dir`. */
export function hashTree(dir) {
  const out = new Map();
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const buf = fs.readFileSync(child);
        out.set(path.relative(dir, child).split(path.sep).join("/"), {
          sha256: createHash("sha256").update(buf).digest("hex"),
          bytes: buf.length,
        });
      }
    }
  };
  walk(dir);
  return out;
}

/** One stable hash for a whole tree, so a waiver can name an exact state. */
export function treeFingerprint(tree) {
  const lines = [...tree.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, meta]) => `${file} ${meta.sha256}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Compare two extracted package trees. Returns { drifted, added, removed,
 * changed, fingerprint } where each list holds file paths (changed entries
 * carry both byte counts, because "how much moved" is the first thing a
 * reviewer asks).
 *
 * `fingerprint` covers both sides, so it changes if either the published
 * artifact or the local build changes by a single byte.
 */
export function compareTrees(localDir, publishedDir) {
  const local = hashTree(localDir);
  const published = hashTree(publishedDir);
  const added = [];
  const removed = [];
  const changed = [];

  for (const [file, meta] of local) {
    const before = published.get(file);
    if (!before) added.push({ file, bytes: meta.bytes });
    else if (before.sha256 !== meta.sha256)
      changed.push({ file, publishedBytes: before.bytes, localBytes: meta.bytes });
  }
  for (const [file, meta] of published) {
    if (!local.has(file)) removed.push({ file, bytes: meta.bytes });
  }

  const byFile = (a, b) => a.file.localeCompare(b.file);
  added.sort(byFile);
  removed.sort(byFile);
  changed.sort(byFile);

  const fingerprint = createHash("sha256")
    .update(`${treeFingerprint(published)}:${treeFingerprint(local)}`)
    .digest("hex");

  return {
    drifted: added.length + removed.length + changed.length > 0,
    added,
    removed,
    changed,
    fingerprint,
  };
}

/**
 * The rule itself, isolated from how the trees were obtained so the
 * self-test can plant a divergence without touching the network.
 *
 * `publishedDir` is null when the declared version is not on the registry.
 *
 * `waivers` carry pre-existing drift that predates this guard. A waiver is
 * pinned to an exact { name, version, fingerprint }, so it covers the one
 * state it was written for and nothing else: bump the package, or let its
 * content move again, and the waiver stops matching and the guard fails.
 * A waiver on a package that is no longer drifting is itself a failure —
 * dead waivers get deleted, not accumulated. That failure is reported as
 * `stale-waiver`, not `drift`: both stop the build, but a package that was
 * correctly bumped must not be told it "changed without a version bump".
 * The fix for one is a version, the fix for the other is a deleted line.
 */
export function verdictFor({ name, version, localDir, publishedDir, waivers = [] }) {
  const waiver = waivers.find((w) => w.name === name);

  if (publishedDir === null) {
    if (waiver) {
      return {
        name,
        version,
        status: "stale-waiver",
        reason: `${version} is not on the registry, so the waiver in ${BASELINE_BASENAME} (pinned to ${waiver.version}) is stale — delete it`,
      };
    }
    return {
      name,
      version,
      status: "pass",
      reason: `${version} is not on the registry — bump pending, content will ship with it`,
    };
  }

  const diff = compareTrees(localDir, publishedDir);

  if (!diff.drifted) {
    if (waiver) {
      return {
        name,
        version,
        status: "stale-waiver",
        reason: `no drift, but ${BASELINE_BASENAME} still waives this package — delete the stale waiver`,
        diff,
      };
    }
    return { name, version, status: "pass", reason: `identical to the published ${version}`, diff };
  }

  if (waiver && waiver.version === version && waiver.fingerprint === diff.fingerprint) {
    return {
      name,
      version,
      status: "waived",
      reason: `known pre-existing drift, waived by ${BASELINE_BASENAME} pending ${waiver.issue}`,
      diff,
    };
  }

  const stale =
    waiver && ` (the waiver in ${BASELINE_BASENAME} does not cover this state — it pins ${waiver.name}@${waiver.version} at ${waiver.fingerprint.slice(0, 12)}…, this is ${version} at ${diff.fingerprint.slice(0, 12)}…)`;

  return {
    name,
    version,
    status: "drift",
    reason: `content differs from the published ${version}, which is immutable — bump the version${stale || ""}`,
    diff,
  };
}

// ---------------------------------------------------------------------------
// Acquiring the two trees
// ---------------------------------------------------------------------------

const BASELINE_BASENAME = "scripts/publish-drift-baseline.json";

class CheckError extends Error {}

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function extract(tgz, into) {
  fs.mkdirSync(into, { recursive: true });
  run("tar", ["-xzf", tgz, "-C", into]);
  // Every npm tarball roots its content at `package/`.
  const root = path.join(into, "package");
  if (!fs.existsSync(root)) throw new CheckError(`${tgz} has no package/ root`);
  return root;
}

/** `npm pack` the working copy and extract it. */
function packLocal(pkgDir, scratch) {
  const dest = path.join(scratch, "local-tgz");
  fs.mkdirSync(dest, { recursive: true });
  let stdout;
  try {
    stdout = run("npm", ["pack", "--pack-destination", dest, "--silent"], pkgDir);
  } catch (err) {
    throw new CheckError(
      `npm pack failed in ${pkgDir} — is the workspace built? (npx turbo run build)\n${err.stderr || err.message}`,
    );
  }
  const file = stdout.trim().split("\n").filter(Boolean).pop();
  if (!file) throw new CheckError(`npm pack produced no tarball in ${pkgDir}`);
  return extract(path.join(dest, file), path.join(scratch, "local"));
}

/**
 * Fetch the published tarball for name@version and extract it.
 * Returns null when the version is absent from the registry.
 *
 * A 404 on the package document means "never published" — a real answer.
 * Any other non-OK response is an unanswered question and throws, because
 * a check that cannot see the registry must not report "clean".
 */
async function fetchPublished(name, version, scratch) {
  const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new CheckError(`registry returned ${res.status} for ${name} (${url})`);
  const doc = await res.json();

  const entry = doc.versions?.[version];
  if (!entry) return null;
  const tarballUrl = entry.dist?.tarball;
  if (!tarballUrl) throw new CheckError(`${name}@${version} has no dist.tarball on the registry`);

  const tarRes = await fetch(tarballUrl);
  if (!tarRes.ok) throw new CheckError(`downloading ${tarballUrl} returned ${tarRes.status}`);
  const dest = path.join(scratch, "published.tgz");
  fs.writeFileSync(dest, Buffer.from(await tarRes.arrayBuffer()));
  return extract(dest, path.join(scratch, "published"));
}

// ---------------------------------------------------------------------------
// Workspace sweep
// ---------------------------------------------------------------------------

export function publishablePackages(packagesDir) {
  const out = [];
  for (const dir of fs.readdirSync(packagesDir).sort()) {
    const manifest = path.join(packagesDir, dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
    // `"private": true` is npm's do-not-publish flag; the publish workflow
    // skips these, so nothing can drift against a registry entry.
    if (pkg.private === true) continue;
    out.push({ name: pkg.name, version: pkg.version, dir: path.join(packagesDir, dir) });
  }
  return out;
}

export function loadWaivers(repoRoot) {
  const file = path.join(repoRoot, BASELINE_BASENAME);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).waivers ?? [];
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const onlyAt = argv.indexOf("--only");
  const only = onlyAt === -1 ? null : argv[onlyAt + 1];

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const waivers = loadWaivers(repoRoot);
  const packages = publishablePackages(path.join(repoRoot, "packages")).filter(
    (p) => !only || p.name === only,
  );
  if (packages.length === 0) throw new CheckError(`no publishable package matched ${only ?? "*"}`);

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publish-drift-"));
  const results = [];
  try {
    for (const pkg of packages) {
      const scratch = path.join(scratchRoot, pkg.name.replace(/[^a-z0-9]+/gi, "-"));
      fs.mkdirSync(scratch, { recursive: true });
      const publishedDir = await fetchPublished(pkg.name, pkg.version, scratch);
      const localDir = publishedDir === null ? scratch : packLocal(pkg.dir, scratch);
      results.push(verdictFor({ ...pkg, localDir, publishedDir, waivers }));
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  if (asJson) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const mark = { pass: "✓", waived: "!", drift: "✗", "stale-waiver": "✗" }[r.status];
      console.log(`${mark} ${r.name}@${r.version} — ${r.reason}`);
      if (r.diff?.drifted) {
        for (const c of r.diff.changed)
          console.log(`    changed  ${c.file}  ${c.publishedBytes} -> ${c.localBytes} bytes`);
        for (const a of r.diff.added) console.log(`    added    ${a.file}  ${a.bytes} bytes`);
        for (const d of r.diff.removed) console.log(`    removed  ${d.file}  ${d.bytes} bytes`);
        console.log(`    fingerprint ${r.diff.fingerprint}`);
      }
    }
  }

  // Two different failures with two different fixes, reported separately so
  // the annotation a reviewer sees matches what they actually have to do.
  const drifted = results.filter((r) => r.status === "drift");
  const stale = results.filter((r) => r.status === "stale-waiver");
  const waived = results.filter((r) => r.status === "waived");

  if (drifted.length > 0) {
    console.error("");
    console.error(
      `::error::${drifted.length} package(s) changed without a version bump: ${drifted
        .map((r) => `${r.name}@${r.version}`)
        .join(", ")}. npm versions are immutable — republishing over them is impossible, so this content is unreachable to consumers until the version is bumped.`,
    );
  }
  if (stale.length > 0) {
    console.error("");
    console.error(
      `::error::${stale.length} stale waiver(s) in ${BASELINE_BASENAME}: ${stale
        .map((r) => `${r.name}@${r.version}`)
        .join(", ")}. These packages no longer match the state their waiver was written for — the fix is to delete the waiver entry, not to change a version.`,
    );
  }
  if (drifted.length > 0 || stale.length > 0) process.exit(1);
  console.log(
    `\n${results.length} publishable package(s) checked, no new unbumped drift` +
      (waived.length > 0
        ? `; ${waived.length} pre-existing waived (${waived.map((r) => r.name).join(", ")}).`
        : "."),
  );
}

// Only run the CLI when invoked directly; the self-test imports this module.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`::error::publish drift check could not run: ${err.message}`);
    process.exit(2);
  });
}
