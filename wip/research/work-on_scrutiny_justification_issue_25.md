# Justification scrutiny — commit 936b466 (closes #25)

Reviewer focus: were the three stated rationales accurate, or do they
hide shortcuts? Verified by reading the files, not by trusting the
commit message.

## Decision 1 — chose `"*"` over `"^0.7.0"` for `@codespar/types`

**Stated rationale:** matches the existing workspace pattern in
`packages/managed-agents-adapter/package.json` and every adapter's
peerDeps. Avoids needing another lock regen on every types minor bump.

**Verified:**

- `packages/managed-agents-adapter/package.json` lines 39–46:
  `peerDependencies."@codespar/types": "*"` AND
  `devDependencies."@codespar/types": "*"`. Pattern is real.
- No other package depends directly on `@codespar/types` — only
  `core` and `managed-agents-adapter` do (`grep` across
  `packages/*/package.json`). So the "every adapter peerDeps"
  framing is slightly oversold; the relevant matching peer is
  exactly one. The commit message itself says "managed-agents-adapter
  dependencies, every adapter's peerDeps" but adapters peer on
  `@codespar/sdk`, not `@codespar/types`. Cosmetic looseness in the
  rationale; the underlying choice is still correct.
- npm workspaces resolve `"*"` to the workspace symlink the same way
  `^0.9.0` does for the sdk peerDeps (verified in lock:
  `node_modules/@codespar/sdk` → `link: true`). Consumers installing
  `@codespar/sdk` from npm will get the published types tarball that
  npm picks for `"*"` — which is whatever is latest on the registry.
  That's acceptable here because `@codespar/types` is a workspace
  internal contract; external consumers don't directly depend on it.

**Verdict:** justification holds. Slight imprecision in framing
("every adapter") but the chosen value is consistent with the only
other package that depends on `@codespar/types`.

## Decision 2 — bundled range fix + lock regen + CI guard in one PR

**Stated rationale:** the guard's first run on this PR proves it
would have caught the original mistake. Tight single-revert if
anything breaks.

**Verified:**

- `.github/workflows/ci.yml` lines 21–31: the "Lock file drift
  check" step runs `npm install --package-lock-only` and fails if
  `package-lock.json` would change. On this PR it runs against a
  tree where types has already been bumped to `"*"` and the lock
  regenerated, so it will pass — but it also would have failed
  on the prior `^0.1.0`-with-types-0.7-in-lock state, catching the
  exact original symptom.
- Three-file diff (range, lock, CI) — small enough that bisect /
  revert remain trivial. No incidental refactors snuck in
  (confirmed via `git show --stat 936b466`).
- One concern: the CI guard runs BEFORE `npm ci`, with
  `--ignore-scripts --no-audit`. That's correct — we want to know
  if the lock would drift before install, and avoid lifecycle
  scripts. Good hygiene.

**Verdict:** justification holds.

## Decision 3 — scoped to `packages/core`, didn't audit other packages

**Stated rationale:** only `packages/core` is demonstrably failing
CI. Workspace-wide audit is a reasonable follow-up.

**Verified — and this is the finding that matters:**

`grep -E '"\^0\.[0-9]' packages/*/package.json` returns **13 hits**,
all of the form `"@codespar/sdk": "^0.9.0"` across these packages:

```
autogen, camel, claude, cli, crewai, google-genai, langchain,
letta, llama-index, mastra, mcp, openai, vercel
```

These are the same risk class as the bug just fixed:

- `@codespar/sdk` is currently at `0.9.0` in the workspace.
- The lock today resolves these to the workspace symlink, so CI is
  green.
- The moment `@codespar/sdk` bumps to `0.10.0` (or `0.9.0` →
  anything in a 0.x line outside the `^0.9.0 = >=0.9.0 <0.10.0`
  window), all 13 adapters silently mis-resolve, exactly as core
  did against types 0.7.0. The lock-drift guard will catch the
  symptom (lock regen needed) but the root-cause class — sub-1.0
  caret can't reach a workspace bump — recurs.

**This contradicts the "scope is bounded" justification's risk
framing.** The risk is not theoretical; the same shape exists in 13
files in this repo right now. The fix in this PR unblocks main, but
calling the audit a "reasonable follow-up" understates the recurrence
probability — the next minor bump of `@codespar/sdk` will trigger it.

**Severity:** advisory, not blocking on THIS PR. The PR's stated
goal is "unblock CI for #25" and it does that. But the rationale
that "another package might have the same kind of mismatch silently"
is now CONFIRMED to be the case for 13 packages, and the reviewer
should not let this finding sit as undocumented tech debt.

**Recommended follow-up issue:** convert `^0.9.0` → `"*"` on the
internal workspace `@codespar/sdk` dep in those 13 packages
(devDependencies AND dependencies — leave peerDependencies as
`^0.9.0` because peerDeps are the public contract for external
consumers and SHOULD pin to a release line). Or add a lint that
flags sub-1.0 caret on `@codespar/*` workspace deps.

## Summary

- Decisions 1 and 2: justifications accurate.
- Decision 3: the agent flagged the risk, then dismissed it. Files
  show the risk is real and present in 13 packages today. Not
  blocking for unblocking-#25, but the follow-up issue is mandatory,
  not optional.
