# Completeness Scrutiny — Issue #25 / Commit 936b466

Focus: **completeness** — does every acceptance criterion have a corresponding implementation in the commit, and are the claims verifiable from the diff?

## Commit under review

`936b466 fix(deps): bump @codespar/types range in core and regenerate lock`

Files touched (3, matches plan exactly):
1. `packages/core/package.json` — dependency range change
2. `package-lock.json` — regenerated
3. `.github/workflows/ci.yml` — new drift-detection step

## AC-by-AC verification

### AC1: `(cd packages/core && npx tsc --noEmit)` is clean — no TS2305 errors

**PASS.** Ran locally against `HEAD` (936b466). Command produced no output, exit 0. The TS2305 failures described in the commit message (`DiscoverOptions`, `ConnectionWizardOptions`, `PaymentStatus*`, `Verification*`, `ChargeArgs/Result`, `ShipArgs/Result`) no longer occur because workspace `@codespar/types@0.7.0` now satisfies the `*` range and resolves to the workspace symlink rather than the published 0.1.0 tarball.

### AC2: `npx turbo run build typecheck test` is green from workspace root

**PASS.** Ran from `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core`. Result:

```
Tasks:    50 successful, 50 total
Cached:    50 cached, 50 total
  Time:    100ms >>> FULL TURBO
```

All 50 tasks across the monorepo green (cached, but cache hits imply prior green runs are still valid under the current `package.json` + lock state — turbo invalidates on input changes).

### AC3: `git diff --exit-code -- package-lock.json` after a fresh `npm install --package-lock-only` is clean

**PASS.** Ran `npm install --package-lock-only --ignore-scripts --no-audit` at HEAD, then `git diff --exit-code -- package-lock.json` returned 0. Lockfile is in sync with all package.json files in the workspace.

### AC4: New CI step would have failed against the pre-fix state

**PASS.** Simulated the pre-fix state by reverting only `packages/core/package.json` to `"@codespar/types": "^0.1.0"` (lockfile from HEAD), then ran the exact command from the new CI step (`npm install --package-lock-only --ignore-scripts --no-audit`). Result: `package-lock.json` mutated (1 line changed), so the subsequent `git diff --exit-code -- package-lock.json` in the new step would exit 1 and fail the job. Restored the working tree to clean afterwards.

The drift-check step (lines 21-31 of `.github/workflows/ci.yml`):
- runs BEFORE `npm ci` (correct placement — catches drift before install can mask it),
- uses `--ignore-scripts --no-audit` (safe / fast),
- emits `::error::` annotations and a `::group::diff` payload (good DX),
- exits 1 on drift.

### AC5: Issue #25 body is updated to reflect the corrected diagnosis

**NOT YET DONE — explicitly deferred per instructions.** The prompt notes this happens during PR creation, after scrutiny. Not a blocker for this commit.

## Additional checks

- **Range choice (`*` vs caret).** Switching to `"@codespar/types": "*"` matches the established workspace pattern (the commit body cites `managed-agents-adapter` and every adapter's `peerDeps`). Inside an npm workspace, `*` resolves to the workspace symlink first, so this is the canonical way to keep a workspace-internal dep tracking the in-tree version. Acceptable.
- **Lock diff scope.** The lock changes are exactly what the commit message claims: the nested `packages/cli/node_modules/@codespar/sdk@0.3.0` and `packages/cli/node_modules/@codespar/types@0.1.0` entries are removed, the `packages/core` `@codespar/types` range is updated to `*`, and version bumps for `api-types` (0.4.0→0.5.0) and `cli` (0.3.0→0.4.0) reflect the workspace state at HEAD (those were already merged in commits `a0734ff` and `c4965c1`; the regen just synced the root lock to those versions). No surprise nested installs introduced.
- **CI step ordering.** Drift check sits between `actions/setup-node` (with `cache: npm`) and `npm ci`. This is the correct slot — running before `npm ci` means the check evaluates the committed lock against committed package.json files only, not against a populated `node_modules/`.

## Blocking findings

None.

## Advisory findings

1. **(advisory)** The drift step runs `npm install --package-lock-only` without `--workspaces` or `--include-workspace-root` flags. In current npm (10.x), workspaces are included by default at the workspace root, so this is fine. Worth a sanity check that the GHA runner uses npm ≥ 9 (Node 20 from `setup-node` ships npm 10.x, so this is satisfied transitively).
2. **(advisory)** No regression test was added for the specific `@codespar/types` import surface. The drift check guards against the *range* recurring, but not against a future change re-pinning to a sub-1.0 caret of a published version. Not in scope for a CI-unblocking fix; raise as a follow-up if the team wants belt-and-suspenders.
3. **(advisory)** AC5 (issue body rewrite) is still pending. Confirm during PR creation that the new body cites the actual TS2305 root cause and not the `npm ci` red-herring.

## Verdict

All four verifiable ACs are satisfied with evidence in the diff and reproducible locally. AC5 is correctly deferred to PR creation. Commit is complete.
