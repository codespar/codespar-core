/**
 * Resolve which published @codespar/sdk the hosted-runtime smoke installs.
 *
 * Prints one version to stdout; diagnostics go to stderr as workflow
 * commands. The workspace version is read from packages/core/package.json
 * and the registry through scripts/npm-registry.mjs.
 *
 * SMOKE_SDK_MODE selects how strictly the published version must match:
 *
 *   exact        — the workspace version must be on the registry. Used on
 *                  manual runs and after the Publish workflow completes,
 *                  which is the only moment the exact version is known to
 *                  exist: the publish happens after the bump merges, so
 *                  neither a PR nor the push to main can require it.
 *   at-or-below  — install the newest published release at or below the
 *                  workspace version, with a ::warning:: when it is older.
 *                  Used on pull requests and on push to main.
 *
 * A package document 404 is "nothing published" (a real answer); a registry
 * that cannot be reached is reported as such. The two need different fixes.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RegistryError, publishedVersions } from "./npm-registry.mjs";

export const PACKAGE = "@codespar/sdk";

export function parseRelease(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Pure choice: given the mode, the workspace version and the published
 * release list, return `{ version }`, `{ version, warning }` or `{ error }`.
 */
export function pickVersion(mode, workspace, published) {
  if (mode !== "exact" && mode !== "at-or-below") {
    return { error: `SMOKE_SDK_MODE must be "exact" or "at-or-below", got ${JSON.stringify(mode)}` };
  }
  const wanted = parseRelease(workspace);
  if (!wanted) return { error: `packages/core/package.json declares a non-release version: ${workspace}` };

  if (published.includes(workspace)) return { version: workspace };

  if (published.length === 0) {
    return { error: `${PACKAGE} has never been published to the registry` };
  }
  if (mode === "exact") {
    return {
      error:
        `${PACKAGE}@${workspace} is not on the registry. The workspace declares ${workspace}; ` +
        `publish it before this job can prove anything about the current SDK.`,
    };
  }
  const candidates = published
    .map((v) => [v, parseRelease(v)])
    .filter(([, p]) => p && compare(p, wanted) < 0)
    .sort((a, b) => compare(a[1], b[1]));
  if (candidates.length === 0) {
    return { error: `no published ${PACKAGE} release is at or below the workspace version ${workspace}` };
  }
  const [version] = candidates[candidates.length - 1];
  return {
    version,
    warning:
      `${PACKAGE}@${workspace} is not published yet; smoke runs against ${version}, ` +
      `the newest release at or below it. After the Publish workflow this job requires the exact version.`,
  };
}

export async function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const workspace = JSON.parse(
    readFileSync(resolve(HERE, "../packages/core/package.json"), "utf8"),
  ).version;

  let published;
  try {
    published = await publishedVersions(PACKAGE);
  } catch (err) {
    if (!(err instanceof RegistryError)) throw err;
    console.error(`::error::${err.message} — a registry or network error, not a publish gap`);
    return 1;
  }

  const pick = pickVersion(process.env.SMOKE_SDK_MODE ?? "exact", workspace, published);
  if (pick.error) {
    console.error(`::error::${pick.error}`);
    return 1;
  }
  if (pick.warning) console.error(`::warning::${pick.warning}`);
  process.stdout.write(`${pick.version}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
