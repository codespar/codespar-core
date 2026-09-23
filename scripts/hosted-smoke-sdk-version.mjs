/**
 * Resolve which published @codespar/sdk the hosted-runtime smoke installs.
 *
 * Prints one version to stdout; diagnostics go to stderr as workflow
 * commands. The workspace version is read from packages/core/package.json.
 *
 * SMOKE_SDK_MODE selects how strictly the published version must match:
 *
 *   exact        — the workspace version must be on the registry. Used on
 *                  push to main and on manual runs: main is what the
 *                  publish ceremony ships, so "not published" there is a
 *                  real finding.
 *   at-or-below  — install the newest published version that is <= the
 *                  workspace version, with a ::warning:: when it is older.
 *                  Used on pull requests: a release PR bumps the version
 *                  before `npm publish` runs, so an exact pin would fail
 *                  every release PR on a 404 and turn the job red as a
 *                  matter of routine.
 *
 * A registry that cannot be reached is reported as such, not as "not
 * published": the two need different fixes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@codespar/sdk";
const HERE = dirname(fileURLToPath(import.meta.url));

function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const mode = process.env.SMOKE_SDK_MODE ?? "exact";
if (mode !== "exact" && mode !== "at-or-below") {
  fail(`SMOKE_SDK_MODE must be "exact" or "at-or-below", got ${JSON.stringify(mode)}`);
}

const workspace = JSON.parse(
  readFileSync(resolve(HERE, "../packages/core/package.json"), "utf8"),
).version;
const wanted = parse(workspace);
if (!wanted) fail(`packages/core/package.json declares a non-release version: ${workspace}`);

let published;
try {
  const out = execFileSync("npm", ["view", PACKAGE, "versions", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  published = JSON.parse(out);
  if (typeof published === "string") published = [published];
} catch (err) {
  const lines = (err.stderr ?? err.message ?? "").toString().trim().split("\n");
  const detail = lines.find((l) => /code |E[A-Z]{3,}|E\d{3}/.test(l)) ?? lines[0] ?? "";
  fail(`could not read ${PACKAGE} versions from the registry (network or registry error, not a publish gap): ${detail}`);
}

if (published.includes(workspace)) {
  process.stdout.write(`${workspace}\n`);
  process.exit(0);
}

if (mode === "exact") {
  fail(
    `${PACKAGE}@${workspace} is not on the registry. The workspace declares ${workspace}; ` +
      `publish it before this job can prove anything about the current SDK.`,
  );
}

const candidates = published
  .map((v) => [v, parse(v)])
  .filter(([, p]) => p && compare(p, wanted) < 0)
  .sort((a, b) => compare(a[1], b[1]));
if (candidates.length === 0) {
  fail(`no published ${PACKAGE} release is at or below the workspace version ${workspace}`);
}
const [pick] = candidates[candidates.length - 1];
console.error(
  `::warning::${PACKAGE}@${workspace} is not published yet; smoke runs against ${pick}, ` +
    `the newest release at or below it. On main this job requires the exact version.`,
);
process.stdout.write(`${pick}\n`);
