# Justification scrutiny round 2 — commit 4249295 (closes #25)

Reviewer focus: do decisions 4–6 hold up, and do rounds 1–3 decisions still
stand on the new state? Verified by reading the actual files, not by
trusting the commit message.

## Decision 4 — clean-regenerate the lock (`rm package-lock.json && npm install`)

**Stated rationale:** the incremental `npm install` from round 1 left a
stale `packages/core/node_modules/@codespar/types@0.1.0` entry because
`0.1.0` still satisfies the new `*` range; only a fresh resolution
prunes it.

**Verified against the files:**

- `git show origin/main:package-lock.json | grep -nE '"packages/[^"]+/node_modules/@codespar/'`
  returns **3 lines** in the pre-fix lock (lines 2041, 2054, 2080):
  `packages/cli/node_modules/@codespar/sdk`,
  `packages/cli/node_modules/@codespar/types`,
  `packages/core/node_modules/@codespar/types`. Confirms the round-1
  partial install really did leave stale nested entries (and shows
  another stale entry under `packages/cli`, not just `packages/core`).
- Same grep against the post-fix lock on the branch: **0 lines**. The
  clean regen pruned every nested `@codespar/*` install — the
  workspace cross-deps now resolve via top-level symlinks, as
  required.
- `npm install --package-lock-only --ignore-scripts --no-audit
  --dry-run` against the current tree reports "up to date in 283ms".
  The lock is idempotent under re-resolution; no drift remaining.
- Cost: ~900 added lines in `package-lock.json` (integrity hashes +
  resolved URLs for fresh top-level resolution). This is the price of
  certainty. Lock-file noise in a single fix-up commit is acceptable
  and reviewable via the grep checks, not line-by-line.

**Verdict:** justification holds. The "incremental install leaves
satisfying-but-stale entries" claim is provable: the smoking gun
(3 stale lines in origin/main) is right there in the pre-fix lock.
Clean regen is the correct hammer; 900 lines of noise is the
unavoidable trade-off.

## Decision 5 — two-layer CI guard (grep + lock-only diff)

**Stated rationale:** Layer A (grep for nested `packages/*/node_modules/@codespar/`)
catches stale nested entries; Layer B (`npm install --package-lock-only`
+ diff) catches "bumped a range but forgot to regen lock". A single
layer would miss one class.

**Verified against `.github/workflows/ci.yml` lines 21–39:**

- Layer A (lines 22–28): regex `"packages/[^"]+/node_modules/@codespar/`
  — targeted to the failure mode we just experienced. It catches the
  exact class round 1 missed. Confirmed: this grep against the pre-fix
  origin/main lock fails (3 hits); against the post-fix lock passes
  (0 hits). The guard would have caught the round-1 regression.
- Layer B (lines 29–39): copies the committed lock to `/tmp`, runs
  `npm install --package-lock-only --ignore-scripts --no-audit`, then
  `diff -q`. Restores the committed lock on failure (line 37) to avoid
  polluting the workspace. Catches "range bumped, lock not regen'd"
  which Layer A cannot detect (e.g. if no nested install would result
  but lock is otherwise stale).
- Are the two layers truly distinct? Yes — they fail on different
  inputs:
  - Stale nested entry that still satisfies declared range: Layer A
    catches (grep hits), Layer B may NOT catch (npm `--package-lock-only`
    is conservative and may preserve satisfying entries — which is
    exactly the round-1 bug).
  - Range bumped but lock untouched: Layer B catches via diff;
    Layer A may not (no nested entries necessarily).
  Both ordered before `npm ci` (line 41), so we know about drift
  before install. Correct ordering.
- Minor concern: Layer B's `--ignore-scripts --no-audit` flags are
  hygiene-correct; comments explaining the two-layer split would help
  the next maintainer, but the commit message itself is the
  contemporaneous record.

**Verdict:** justification holds. Two layers ARE distinct (different
failure modes), and the round-1 incident is the proof that a single
layer is insufficient. Not "splitting hairs."

## Decision 6 — didn't preemptively fix the 13 adapter `^0.9.0` deps

**Stated rationale:** workspace `@codespar/sdk` is at 0.9.0, so all
13 adapter `^0.9.0` deps resolve via symlink today. When sdk bumps
to 0.10.x the bug springs everywhere at once and Layer A grep
catches it immediately.

**Verified:**

- 13 adapter `package.json` files still carry `"@codespar/sdk":
  "^0.9.0"`: autogen, camel, claude, cli, crewai, google-genai,
  langchain, letta, llama-index, mastra, mcp, openai, vercel.
  Confirmed by grep against `packages/*/package.json`.
- Lock currently resolves all 13 to the workspace symlink (verified
  in lock at lines 2491, 2505, 2519, 2533, 2569, 2583, 2597, 2613,
  2627, 2658, 2672, 2686, 2713 — every adapter entry has
  `"@codespar/sdk": "*"` rewritten under workspace resolution while
  the package.json dep stays `^0.9.0`).
- When `@codespar/sdk` bumps to 0.10.0, `^0.9.0` excludes 0.10.0,
  npm will reach for the registry tarball of last published 0.9.x
  for those 13 packages — exactly the failure mode this PR fixed
  for `@codespar/types`. The guard's Layer A grep will then hit:
  fresh `packages/{adapter}/node_modules/@codespar/sdk` entries
  appear in the regenerated lock, CI fails loudly.
- The trade-off "let the guard catch it later" rests on: (a) the
  guard actually catching it — verified above; (b) the cost of a
  failed CI run on the sdk-bump PR being acceptable — yes, that PR
  is the right place to coordinate the workspace-wide range bump
  anyway; (c) this PR staying narrowly scoped to its stated goal
  ("unblock CI for #25") — yes.
- Round-1 reviewer flagged the same 13 packages as advisory tech
  debt. That advisory still stands; this round doesn't elevate it
  to blocking because the guard provides the safety net.

**Verdict:** justification holds, conditional on the guard being
trusted to catch the regression. We just verified it does. Acceptable
to defer.

## Re-confirming rounds 1–3 decisions on the new state

- **Decision 1 (`*` for `@codespar/types`):** unchanged in `packages/core/package.json`
  (line 51). Pattern still matches `managed-agents-adapter` (and now
  matches `@codespar/sdk` as expressed by 13 adapter packages — albeit
  with the caveat that adapters still pin via caret). Justification
  intact.
- **Decision 2 (bundled range + lock + CI in one PR):** scope is now
  three files (range, lock, CI) with one fix-up commit; bisect/revert
  still trivial. Fix-up commit cleanly separates "clean regen" from
  the original "range bump" — actually makes bisect easier than a
  single squashed commit would.
- **Decision 3 (scope to `packages/core`):** still scoped to core's
  range. The 13-package follow-up is now MORE justified because
  decision 6 explicitly relies on the guard to catch the recurrence;
  document the follow-up issue or risk drift.

## Summary

Decisions 4–6 justifications all hold. Decision 4's "stale entry"
claim is provable in the pre-fix origin/main lock (3 stale lines).
Decision 5's two-layer split is genuinely two distinct failure modes,
not hair-splitting — round 1's incident is the empirical proof. Decision
6's deferral is acceptable because the guard (now verified to catch
the failure class) provides the safety net.

One advisory carries over from round 1: the 13 adapter packages with
`^0.9.0` are a ticking-bug-on-next-sdk-bump. Decision 6 makes the
follow-up issue more urgent, not less — it should be filed and linked
from this PR.

**Blocking count: 0. Advisory count: 1** (file workspace-wide
sub-1.0-caret follow-up issue, link from PR).
