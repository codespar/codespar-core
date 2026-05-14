# Intent Scrutiny — fix/25-package-lock-drift @ 936b466

Reviewer focus: INTENT. Does the implementation actually serve the
stated goals?

## Stated intents

- (a) Turn main green by addressing the real typecheck failure.
- (b) Prevent this entire class of drift (literal lock drift AND
  declared-range-can't-reach-workspace) from recurring silently.
- (c) Keep issue #25 as the tracking record.
- (d) Unblock open PR #23 (which inherits main's red CI).

## Verdict

**Intent (a) NOT served. Intent (b) NOT served. Intent (d) NOT served.**
Intent (c) is procedural and will be handled at PR creation time, so
not in scope of this review.

## Reproduction of the failure on the fix branch

Steps run from a clean checkout of `fix/25-package-lock-drift`:

```
rm -rf node_modules packages/*/node_modules
npm ci --ignore-scripts --no-audit          # what CI runs
ls packages/core/node_modules/@codespar/    # -> "types"
cat packages/core/node_modules/@codespar/types/package.json | grep version
                                            # -> "version": "0.1.0"
cd packages/core && npm run typecheck       # FAILS with the same 12
                                            # TS2305 errors the commit
                                            # message says are fixed
```

Failing errors are byte-identical to the pre-fix breakage:

```
src/session.ts(17,3): error TS2305: Module '"@codespar/types"' has no
  exported member 'DiscoverOptions'.
... (12 errors total — DiscoverOptions, DiscoverResult,
ConnectionWizardOptions, ConnectionWizardResult, PaymentStatusResult,
PaymentStatusStreamOptions, VerificationStatusResult,
VerificationStatusStreamOptions, ChargeArgs, ChargeResult, ShipArgs,
ShipResult)
```

## Root cause of the residual breakage

The committed `package-lock.json` still contains a stale tarball entry:

```
"packages/core/node_modules/@codespar/types": {
  "version": "0.1.0",
  "resolved": "https://registry.npmjs.org/@codespar/types/-/types-0.1.0.tgz",
  ...
}
```

The fix correctly changed `packages/core/package.json` from
`"@codespar/types": "^0.1.0"` to `"@codespar/types": "*"`. The lock
regen, however, was a partial regen (`npm install` with a pre-existing
lock and partially-populated `node_modules`), not a clean regen. npm
preserved the old nested entry because it is technically still
satisfiable by `"*"`. The hoisted top-level symlink to `packages/types`
is also present (`node_modules/@codespar/types -> packages/types`), but
Node module resolution walks UP from the importing file. From
`packages/core/src/session.ts`, the FIRST `node_modules/@codespar/types`
it sees is the nested `0.1.0` tarball — the workspace symlink at the
root never gets a chance.

Demonstrated by deleting the lock entirely and regenerating from
scratch:

```
rm -rf node_modules packages/*/node_modules package-lock.json
npm install --ignore-scripts --no-audit
# -> no `packages/core/node_modules/@codespar/types` entry produced
cd packages/core && npm run typecheck   # passes
```

A genuinely clean lock differs from the committed one and unblocks
typecheck. The committed lock does not.

## Q1 — would the new CI step have caught the actual root cause?

**No.** `npm install --package-lock-only` does NOT delete pre-existing
nested lock entries that remain satisfiable. With the broken
`^0.1.0` declaration in core, `--package-lock-only` would have kept
the stale `0.1.0` nested entry exactly as it does today — same lock in,
same lock out, no drift detected, green check.

Worse: the drift check is currently green AGAINST THE BROKEN LOCK
SHIPPED IN THIS PR. Verified:

```
cp package-lock.json /tmp/snapshot.json
npm install --package-lock-only --ignore-scripts --no-audit
diff -q /tmp/snapshot.json package-lock.json   # UNCHANGED
```

So the prevention mechanism this PR ships does not detect the very
breakage this PR ships.

To catch the actual root cause class, the guard must do one of:

1. `rm package-lock.json && npm install` and diff the result (catches
   any stale-but-tolerated entry), OR
2. Run typecheck and trust the typecheck failure to surface the
   resolution mismatch (which is what CI was supposed to do, and what
   was breaking main), OR
3. Lint package.json files for `@codespar/*` declared ranges and
   compare against the workspace version table — fail when the range
   cannot resolve to the workspace package (e.g. `^0.1.0` against
   workspace `0.7.0`).

## Q2 — other packages with the same latent mismatch?

Survey of `@codespar/*` ranges across the workspace (post-fix):

| File | dep / peer | range | workspace version | resolves? |
|------|-----------|-------|-------------------|-----------|
| `packages/core/package.json` | dep `@codespar/types` | `*` | 0.7.0 | yes |
| `packages/managed-agents-adapter/package.json` | dev+peer `@codespar/types` | `*` | 0.7.0 | yes |
| `packages/cli/package.json` | dep `@codespar/sdk` | `^0.9.0` | 0.9.0 | yes (today) |
| all 12 adapters (autogen, camel, claude, crewai, google-genai, langchain, letta, llama-index, mastra, mcp, openai, vercel) | dev `@codespar/sdk` | `*` | 0.9.0 | yes |
| same adapters | peer `@codespar/sdk` | `^0.9.0` | 0.9.0 | yes (today); peer only warns, doesn't install |

Today no other package is broken. But the CLI's regular-dep `^0.9.0`
range is the same shape that broke core: when SDK bumps to 0.10.x,
`^0.9.0` becomes `>=0.9.0 <0.10.0` and CLI silently falls back to a
tarball install (or fails to install on a fresh lock). Same trap, just
not sprung yet.

The committed CI drift check would NOT catch the CLI variant either —
same reason as Q1.

## Q3 — does step order (before vs after `npm ci`) matter?

No — `git diff package-lock.json` works in either position. Placing
the step BEFORE `npm ci` is slightly faster (no network for the full
install). Position is fine; it's not the position that's broken, it's
the check semantics.

## Q4 — `--ignore-scripts --no-audit` flags

Neither flag hides any drift signal:

- `--ignore-scripts` skips lifecycle hooks; lifecycle scripts don't
  write the lockfile.
- `--no-audit` suppresses the registry audit roundtrip; not relevant
  to lock content.

Both are reasonable hygiene. Not a blocker.

## Q5 — does this PR unblock PR #23?

**No.** PR #23 inherits main's CI. After this fix merges to main, the
same 12 TS2305 errors will fire on PR #23's next CI run because the
broken nested install reappears on every `npm ci`. PR #23 stays red
until the lock is regenerated cleanly.

## Blocking issues

1. **The fix does not actually fix `npm ci` → typecheck on a clean
   CI runner.** The committed lock retains
   `packages/core/node_modules/@codespar/types@0.1.0`. Verified by
   running exactly what `.github/workflows/ci.yml` runs:
   `npm ci` then the typecheck — fails with the original 12 errors.
   Required action: regenerate the lock cleanly
   (`rm package-lock.json && npm install`) before merge.

2. **The CI drift guard does not catch the class of bug it claims to
   catch.** `npm install --package-lock-only` is a no-op against the
   shipped broken lock. The mechanism intended to prevent recurrence
   would not have caught the original failure either. Required
   action: change the guard to either (a) `rm package-lock.json && npm
   install` then diff, or (b) add a step that exercises `npm ci` +
   typecheck on a runner that doesn't share state with the committer's
   local node_modules — which is essentially what the existing CI did
   before, so the guard provides no new defense beyond the lock-drift
   class issue #25 originally described.

## Advisory

1. The CLI package declares `"@codespar/sdk": "^0.9.0"` as a regular
   dependency. Today it resolves to the workspace 0.9.0, but the next
   SDK bump to 0.10.0 reproduces this exact incident in CLI. Either
   move to `"*"` like every adapter's dev dep, or fix the guard to
   detect ranges that won't reach the workspace.

2. The commit message claims "nested 0.1.0/0.3.0 tarball installs drop
   out." Two out of three dropped — `packages/cli/node_modules/@codespar/sdk@0.3.0`
   and `packages/cli/node_modules/@codespar/types@0.1.0`. The third
   (`packages/core/node_modules/@codespar/types@0.1.0`) survived. The
   commit message should be amended if/when the lock is regenerated.

3. If the lock is regenerated cleanly, re-run the full CI (build +
   typecheck + test) locally before pushing. The current commit
   suggests this verification step was skipped or partial.
