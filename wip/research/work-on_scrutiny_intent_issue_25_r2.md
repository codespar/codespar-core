# INTENT Review — Round 2 — Issue #25

**Branch**: `fix/25-package-lock-drift` @ `4249295`
**Round-1 commit reviewed**: `936b466`
**Round-2 fix-up commit**: `4249295`

## Round-1 Blocking Findings — Resolution Status

### Finding 1 — Stale nested `@codespar/types@0.1.0` in lock — RESOLVED

Check executed on HEAD:

```
$ grep -E '"packages/[^"]+/node_modules/@codespar/' package-lock.json
(no matches; exit 1)
```

The lock has been clean-regenerated. The previously offending entries
(`packages/cli/node_modules/@codespar/sdk`,
`packages/cli/node_modules/@codespar/types`,
`packages/core/node_modules/@codespar/types`) are all gone.

Workspace cross-deps now resolve exclusively through top-level
symlinks under `node_modules/@codespar/*` → `packages/*` (verified
`@codespar/types` → `packages/types`, currently at version 0.7.0).

Clean-CI simulation:

```
rm -rf node_modules packages/*/node_modules
npm ci            # 87 packages, 0 vulns, success
cd packages/core
npx tsc --noEmit  # exit 0
```

Typecheck passes against the workspace symlinks — exactly the
failure mode that round-1 blocked on.

### Finding 2 — CI guard insufficient — RESOLVED

The new guard has two layers in `.github/workflows/*.yml`:

- **Layer A — nested-install grep**: fails immediately if any
  `"packages/<x>/node_modules/@codespar/"` entry appears in
  `package-lock.json`. Prints offending lines + remediation hint.
- **Layer B — `npm install --package-lock-only` diff**: catches
  range-vs-lock drift that doesn't manifest as a nested entry.

Layer A retro-validation:

```
$ git show origin/main:package-lock.json \
    | grep -E '"packages/[^"]+/node_modules/@codespar/'
packages/cli/node_modules/@codespar/sdk
packages/cli/node_modules/@codespar/types
packages/core/node_modules/@codespar/types
```

Layer A would have failed CI on `origin/main` and on the round-1
commit (`936b466`) — it catches the exact pathology I flagged.

## Broader Intent Probe

- Lock is now in the canonical npm-workspaces shape (no nested
  workspace-namespace tarballs).
- `@codespar/types` consumers in `packages/core` declare `"*"` and
  resolve to the in-repo `0.7.0` workspace package via symlink — no
  version-skew risk from this lock.
- No latent traps found: I searched for any other
  `packages/*/node_modules/@codespar/*` references and confirmed
  none remain. The two-layer guard will catch a re-introduction
  via either accidental `npm install --prefix packages/<x>` or a
  package.json range bump without a lock regeneration.
- Unblocks PR #23 as intended: the stale `0.1.0` resolution that
  was causing the typecheck failure can no longer occur on a clean
  CI checkout.

## Verdict

Both round-1 blocking findings are resolved. No new blocking
issues. The fix is correct, minimal, and the guard is appropriately
defensive without being over-engineered.

- blocking_count: 0
- advisory_count: 0
