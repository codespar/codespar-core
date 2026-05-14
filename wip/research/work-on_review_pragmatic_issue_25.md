# Pragmatic Review — Issue #25 (fix/25-package-lock-drift)

Lens: simplicity, over-engineering, dead code, scope creep.

## Scope assessment

PR touches exactly three files matching the ask:
- `packages/core/package.json`: `@codespar/types` `^0.1.0` -> `*` (types is at 0.7.0; old range was unresolvable, hence the failure)
- `package-lock.json`: regenerated, no nested `packages/*/node_modules/@codespar/*` entries
- `.github/workflows/ci.yml`: new "Lock file drift check" step before `npm ci`

No scope creep. No unrelated edits. Good.

## Findings

### B1 (blocking, minor) — Dead restore-on-failure in CI

`ci.yml` line 37: `cp /tmp/committed-lock.json package-lock.json` immediately before `exit 1` on an ephemeral GitHub Actions runner. The workspace is destroyed at job end; restoring the lock file has zero effect. Dead code; remove it.

### A1 (advisory) — Two `::error::` lines per failure is slightly noisy

Each failure branch emits two `::error::` annotations (the diagnosis + the "Fix:" hint). GitHub surfaces every `::error::` in the PR summary, so users see two red bullets for one problem. Demoting the "Fix:" line to a plain `echo` keeps the actionable hint visible in logs without doubling the PR-level annotation noise. Nice-to-have.

### A2 (advisory) — `"*"` vs `"workspace:*"`

`"*"` works because npm workspaces hoists the local `@codespar/types`, but `"workspace:*"` (npm 9+) makes the workspace-only intent explicit and would have prevented this class of bug entirely (it cannot accidentally resolve to a registry tarball). Out of scope for an unblock PR; flag for a follow-up.

## Things considered and found NOT problematic

- **Two-layer guard is justified.** Layer A targets the specific issue-#25 failure mode (nested workspace tarball installs). Layer B is the general lock-vs-package.json drift check. They catch different classes of drift; one does not subsume the other. Layer A is cheap (one `grep`); Layer B needs the `npm install --package-lock-only` round-trip. Keeping both is the right call.
- **`::error::` annotations themselves are appropriate.** This is the canonical GitHub Actions mechanism to surface CI failures in the PR view. Not noise.
- **`--ignore-scripts --no-audit`** on Layer B is correct: lock-only regeneration should not run postinstall or hit the audit endpoint.

## Summary

One small piece of dead code (the restore `cp` on an ephemeral runner) and two minor polish items. The two-layer guard is not over-engineering — it covers two distinct drift modes the repo has actually hit. PR is appropriately scoped.
