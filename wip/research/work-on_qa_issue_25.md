# QA Validation — Issue #25 (fix/25-package-lock-drift @ 6e28d97)

## AC1 — `(cd packages/core && npx tsc --noEmit)` clean
PASS. Exit code 0. No TS2305 errors.

## AC2 — `npx turbo run build typecheck test --force`
PASS. `Tasks: 50 successful, 50 total` in 13.165s.

## AC3 — CI path: clean install + AC1 + AC2
PASS.
- `rm -rf node_modules packages/*/node_modules && npm ci`: succeeded, 87 pkgs added, 0 vulns.
- `npx tsc --noEmit` in packages/core: exit 0.
- `npx turbo run build typecheck test --force`: 50/50 successful, 13.542s.

## AC4 — Lock-drift guard would have caught pre-fix state
PASS.
- `git show origin/main:package-lock.json > /tmp/prefix-lock.json`
- `grep -cE '"packages/[^"]+/node_modules/@codespar/' /tmp/prefix-lock.json` → **3** matches (guard fires).
- Same grep against current `package-lock.json` → **0** matches (guard quiet).
- Confirms the new "Lock file drift check" step in `.github/workflows/ci.yml` would have errored on the broken main lock.

## Summary
4/4 acceptance criteria pass. node_modules restored via final `npm ci` step in AC3 (already clean). No regressions observed.
