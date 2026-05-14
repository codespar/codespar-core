# Maintainer Review — fix/25-package-lock-drift

Lens: future developer experience. Could someone six months from now diagnose and fix a CI failure here without spelunking through commit history?

## Files reviewed
- `.github/workflows/ci.yml` (Lock file drift check step, lines 21-39)
- `packages/core/package.json` (`@codespar/types: "*"`, line 51)
- `packages/core/src/index.ts` (line 27: `export * from "@codespar/types"`)
- Workspace-wide grep of `@codespar/*` deps across all `packages/*/package.json`
- Commits 936b466 and 4249295

---

## Blocking findings

**None.** The CI guard messages are self-diagnosing, the commit history is unusually thorough, and the change unblocks the workspace cleanly. A future maintainer hitting either guard layer can fix it from the error output alone.

---

## Advisory findings

### A1. SDK consumers DO get an observable surface change. The commit message frames this as a CI fix, but `packages/core/src/index.ts:27` is `export * from "@codespar/types"`. Before the fix, the installed `@codespar/types` was the **published 0.1.0 tarball** (because `^0.1.0` excluded the workspace 0.7.0). The barrel re-export from `@codespar/sdk` was therefore exporting the 0.1.0 surface to npm consumers. After this fix, `@codespar/sdk@0.9.0` re-exports the 0.7.0 surface (DiscoverOptions, PaymentStatus*, Verification*, ChargeArgs/Result, ShipArgs/Result, ConnectionWizardOptions, etc.).

This is arguably a *correction* — `@codespar/sdk@0.9.0` was meant to expose these types and the type errors were the symptom that it wasn't. But the commit message doesn't acknowledge it. A future maintainer doing `git blame` on a "why did the SDK suddenly export X" question will land on a commit whose subject says "deps,ci: clean-regenerate lock" and will be confused. **Suggest one line in the commit message body or PR description**: "Side effect: `@codespar/sdk@0.9.0` (which barrel-re-exports `@codespar/types`) now actually exposes the 0.7.x surface — previously it shipped 0.1.0 types because the range never matched. This is the intended 0.9.0 surface; no semver bump needed since 0.9.0 hasn't been published with the broken types."

### A2. The `"*"` range is not self-explanatory and is genuinely ambiguous in this monorepo. `npm install` interprets `"*"` as "any version, prefer latest"; in a workspace it resolves to the local workspace package. A new contributor who has used Yarn or pnpm before will expect `"workspace:*"` (which npm does not support as of npm 11). The commit calls `"*"` "the established workspace pattern" — that's true for **devDependencies and peerDependencies** of adapters, but `packages/core/package.json:51` puts it in `dependencies`. Only `managed-agents-adapter` does the same thing in a non-peer/dev slot. A new contributor reading `core/package.json` won't know whether `"*"` is intentional or a typo. **Suggest a one-line comment**, e.g. `"@codespar/types": "*"  // workspace cross-dep — npm resolves to packages/types via the workspaces field; do NOT pin to a semver range`, or document the invariant once in CLAUDE.md.

### A3. The unwritten invariant should be written down. The pending task list (item #7: "File follow-up issue for sub-1.0-caret across 13 adapters") shows the team already knows 13 sibling adapters still have `"@codespar/sdk": "^0.9.0"` in `peerDependencies` — which works today only because `@codespar/sdk` happens to be at 0.9.0. Bumping the SDK to 0.10.0 will silently break every adapter the same way `^0.1.0` broke core. The invariant is: **workspace cross-deps must use `"*"` (or be moved off sub-1.0 versions), never a caret-on-sub-1.0**. CLAUDE.md's "What NOT to do" list is the natural home. The follow-up issue handles the fix; CLAUDE.md should handle the rule.

### A4. Layer B error message could point at WHICH package.json drifted. The current message is "package-lock.json is not in sync with package.json files." then dumps the first 100 lines of diff. Useful, but the diff is on the **lock**, not on package.json. If the diff is large, the affected package isn't obvious. Minor — `grep '"name":' /tmp/committed-lock.json package-lock.json` style enrichment would help, but not blocking.

### A5. The CI step name "Lock file drift check" is good, but neither layer references the other in error output. If Layer A fires, a maintainer might assume Layer B doesn't exist; if Layer B fires after a clean Layer A, they won't realize there's a separate guard for nested entries. Minor doc nit; the current messages are still actionable.

### A6. Layer A's grep pattern is fragile to npm lockfile format changes. It greps for the literal string `"packages/[^"]+/node_modules/@codespar/`. npm 11 still emits this; npm 12 or yarn-via-corepack-migration may not. Not actionable today — call it out so future maintainers know to revisit if they upgrade Node or migrate package managers.

---

## What works well
- Two-layer guard catches two genuinely distinct failure modes (the scrutiny round earned its keep).
- Commit 4249295 explicitly explains why the prior fix was insufficient — exemplary `git blame` material.
- Error messages include the exact remediation command (`rm package-lock.json && npm install`).
- `--ignore-scripts --no-audit` on the dry-run install keeps the guard fast and side-effect-free.
