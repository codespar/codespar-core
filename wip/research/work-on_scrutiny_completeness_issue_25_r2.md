# Completeness scrutiny — issue #25, round 2

Branch: `fix/25-package-lock-drift` @ HEAD `4249295`
Base: `origin/main` @ `a0734ff`

## Acceptance Criteria — verification

| AC | Status | Evidence |
|----|--------|----------|
| `(cd packages/core && npx tsc --noEmit)` clean | PASS | exit 0, no output |
| `npx turbo run build typecheck test` green | PASS | `Tasks: 50 successful, 50 total` (full turbo, cached) |
| `rm -rf node_modules && npm ci` succeeds | PASS | `added 87 packages, and audited 105 packages` with no warnings |
| Layer A would catch pre-fix lock | PASS | `git show origin/main:package-lock.json \| grep -nE '"packages/[^"]+/node_modules/@codespar/'` returns 3 lines: `packages/cli/node_modules/@codespar/sdk`, `packages/cli/node_modules/@codespar/types`, `packages/core/node_modules/@codespar/types` |
| Current lock clean of nested entries | PASS | Same grep on HEAD lock returns nothing |
| Layer B (drift) — lock is in sync | PASS | After `npm install --package-lock-only --ignore-scripts --no-audit`, `diff` reports identical files |
| Issue #25 body update deferred to PR step | ACCEPTABLE | Per task brief |

## Round-1 defect resolution

Round 1 left nested `@codespar/*` tarball entries in the regenerated lock (and/or did not include the structural cleanup). The fix-up commit `4249295`:
- Regenerated `package-lock.json` fully — `grep -E '"packages/[^"]+/node_modules/@codespar' package-lock.json` returns no matches.
- Added two-layer CI guard before `npm ci`:
  - Layer A: `grep -qE '"packages/[^"]+/node_modules/@codespar/'` with actionable error pointing at the regen recipe.
  - Layer B: `npm install --package-lock-only --ignore-scripts --no-audit` + `diff`, with `cp /tmp/committed-lock.json package-lock.json` restore so the runner's working tree is not polluted on failure.

## CI guard quality notes

- The Layer-B `cp` restore on failure is a thoughtful touch — prevents follow-up steps in the same job from being confused.
- `--ignore-scripts --no-audit` on the lock-only install is correct hygiene for a diff check.
- Both `::error::` annotations include the remediation recipe — clear signal to contributors.

## Blocking findings

None. All ACs verified on this machine; the CI path (`npm ci` → turbo build/typecheck/test) is green from a clean install.

## Advisory (non-blocking)

1. Layer B runs an actual `npm install --package-lock-only` on every CI run. Cheap (~340ms locally) but adds a network call. If CI duration ever matters, this could become job-level conditional on `package*.json` changes.
2. The `cp /tmp/committed-lock.json package-lock.json` restore happens only after Layer B's diff fails; if Layer A fails (early exit), no restore is needed because the lock was not modified — current ordering is correct, just worth noting in case the layers are ever reordered.
3. The `"@codespar/types": "*"` range in `packages/core/package.json` is fine for an internal workspace dep (npm resolves to the workspace symlink) but is unusual; a comment or a tightened range would document intent. Pre-existing pattern check not required for this PR.
