# Pragmatic Review — Issue #25, Round 2

**Branch:** fix/25-package-lock-drift
**HEAD:** 6e28d97
**File reviewed:** `.github/workflows/ci.yml`

## Round-1 Findings — Resolution Status

### BLOCKING (R1): Dead `cp /tmp/committed-lock.json package-lock.json` restore before `exit 1`

**Status: RESOLVED.**

Inspected the full workflow file. Layer B's failure branch (lines 30–36) now reads:

```yaml
if ! diff -q /tmp/committed-lock.json package-lock.json >/dev/null; then
  echo "::error::package-lock.json is not in sync with package.json files. Run 'npm install' locally and commit the regenerated package-lock.json."
  echo "::group::diff (first 100 lines)"
  diff /tmp/committed-lock.json package-lock.json | head -100
  echo "::endgroup::"
  exit 1
fi
```

No `cp` restore line remains anywhere in the file. The dead-code path on the ephemeral runner is gone.

### ADVISORY (R1): Doubled `::error::` annotations inflate PR summary red bullets

**Status: RESOLVED.**

Both failure branches now emit a single `::error::` annotation with the remediation folded in:

- Layer A (line 24): one `::error::` containing both the nested-install diagnosis and the `rm package-lock.json && npm install` fix.
- Layer B (line 31): one `::error::` containing both the drift diagnosis and the `npm install` fix.

The drift diff itself is wrapped in an `::group::`/`::endgroup::` block (lines 32–34), which the GitHub UI renders as a collapsible log section rather than an error annotation. PR summaries will now show one red bullet per failing layer, not two.

## New Pragmatic Concerns

None. The workflow remains straightforward: checkout → setup-node → drift check (Layer A nested-install grep, then Layer B `npm install --package-lock-only` diff) → `npm ci` → build/typecheck/test → audit. Logic is linear, exits are clear, error messages are actionable.

## Verdict

Both round-1 findings addressed cleanly. No new blockers or advisories.
