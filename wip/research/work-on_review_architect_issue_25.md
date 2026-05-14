# Architect Review — Issue #25 (fix/25-package-lock-drift)

HEAD `4249295` on top of `origin/main`. Lens: architectural fit.

## Files Inspected

- `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core/packages/core/package.json`
- `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core/packages/types/package.json`
- `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core/packages/managed-agents-adapter/package.json`
- `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core/packages/vercel/package.json` (representative adapter)
- `/home/dgazineu/dev/niwaw/cs/cs-2/public/codespar-core/.github/workflows/ci.yml`
- root `package.json` (npm workspaces, no pnpm)

## A. Dep-range pattern `"*"` for `@codespar/types`

### Workspace cross-dep census

| Package | Where | Range |
|---|---|---|
| `@codespar/sdk` (core) | dependencies → `@codespar/types` | `*` (this PR) |
| `@codespar/managed-agents-adapter` | peerDependencies → `@codespar/types` | `*` |
| `@codespar/managed-agents-adapter` | devDependencies → `@codespar/types` | `*` |
| 12 framework adapters (vercel, claude, openai, mastra, langchain, letta, camel, llama-index, crewai, google-genai, autogen, mcp) | peerDependencies → `@codespar/sdk` | `^0.9.0` |
| 12 framework adapters | devDependencies → `@codespar/sdk` | `*` |
| `@codespar/cli` | dependencies → `@codespar/sdk` | `^0.9.0` |

The PR description says `"*"` matches "every adapter's peerDeps." That is partially incorrect — only `managed-agents-adapter`'s peerDeps use `"*"`. Every other adapter pins `peerDependencies` at `^0.9.0` and reserves `"*"` for devDependencies (where workspace resolution happens during build).

### Is `"*"` architecturally appropriate here?

For `@codespar/sdk → @codespar/types` this is a **runtime `dependencies`** entry, not a peerDep. Once `@codespar/sdk` is published to npm, npm resolves the actual `@codespar/types` from the registry using this range. `"*"` means "any version satisfies" — which is the loosest possible constraint and effectively delegates compatibility to runtime.

The workspace's stronger convention (used by every framework adapter for `@codespar/sdk`) is caret-on-current. Following that convention, this entry would read `"^0.7.0"` (matching `packages/types/package.json` version `0.7.0`) — pinning the contract package the same way adapters pin the SDK. `@codespar/types` re-exports session interfaces (`SessionBase`, `Session`, `ToolResult`) that `@codespar/sdk` imports as types; a 1.0.0 of `@codespar/types` removing a member would silently break `@codespar/sdk` consumers on `npm install` because `"*"` accepts it.

`workspace:*` is correctly rejected — npm workspaces does not support that prefix, only pnpm/yarn-berry do.

Why `"*"` resolves the CI failure: with `"^0.1.0"` in `dependencies`, npm's lockfile generator could not find a registry entry that matched (real version is `0.7.0`), so it fell back to installing a nested tarball under `packages/core/node_modules/@codespar/types`, producing the lock-drift. Bumping the range to anything that matches the workspace version (e.g. `^0.7.0`) would have the same effect. `"*"` was the quickest unblock; `^0.7.0` would have been the lower-blast-radius unblock.

**Verdict:** functional but inconsistent with the dominant workspace convention. Advisory, not blocking.

## B. Dependency direction

Verified no inverse import. `packages/types/src/` contains zero `@codespar/*` imports (grep returns empty). `packages/core/src/` imports only from `@codespar/types` (types-only imports in `index.ts`, `session.ts`, `tools.ts`, `loop.ts`, `types.ts`). The contract-package architecture (types is the leaf, sdk depends on it, adapters depend on both via peerDeps) is preserved. No concern.

## C. CI guard placement

Two layers in `ci.yml`:

- **Layer A** (grep): blocks nested `packages/*/node_modules/@codespar/*` entries in the lockfile — the exact failure mode this PR fixes.
- **Layer B** (`npm install --package-lock-only --ignore-scripts --no-audit` + `diff`): general drift check, catches any case where a `package.json` change wasn't followed by a lockfile regeneration.

### Layer A vs Layer B — does one subsume the other?

Architecturally, Layer B subsumes Layer A. Any nested `@codespar/*` install means the committed lockfile disagrees with what `npm install` would produce *now*, so Layer B's diff would fail with the same exit code. Layer A is a narrow string-grep that catches one failure mode with a tailored error message.

There is a real product reason to keep both: **error message quality**. Layer A says "workspace cross-deps must resolve via symlinks, not tarballs" + cites the offending lines; Layer B says "package.json and lockfile drifted, run npm install." The diagnostic value of Layer A specifically for the failure mode this PR resolves is non-trivial, and an L4 reviewer (yourself) editing this in six months will appreciate the targeted error over a 100-line diff dump.

Acceptable architecturally. Could collapse to Layer B alone with a smarter error parser, but the current shape trades 6 lines of grep for clarity. Advisory.

### Could this live elsewhere?

- **Husky / `prepare` script**: would shift enforcement to local dev. Husky requires an install step and adds a runtime dep. The codebase explicitly avoids extra dev tooling (root `package.json` has only `tsx`, `turbo`, `typescript`). Adding Husky for one check is a bad trade.
- **Separate validation workflow**: would run in parallel to `ci.yml` but on the same trigger (`pull_request` to `main`). No benefit; adds a second workflow file. Net negative for repo navigability.
- **A `prepare` script in root `package.json`**: not enforced unless the developer runs `npm install` after changing a `package.json` — exactly the failure mode the PR is fixing. Useless without CI backstop.

Keeping the check in `ci.yml` as a pre-install step is correct. The ordering (drift check → `npm ci` → build) is also correct: a broken lockfile would make `npm ci` fail with a less-informative error.

### Layer B side effect

Layer B runs `npm install --package-lock-only` on the CI runner and then `cp /tmp/committed-lock.json package-lock.json` on failure to restore the committed file before exit. On success path the regenerated lockfile is left in place and `npm ci` runs against it. If `npm install --package-lock-only` produced a *byte-identical* file (success case), this is fine; if it produced a logically-equivalent but byte-different file that still passes `diff -q`, that cannot happen because `diff -q` is byte-level. No concern.

## D. Other observations

- `peerDependencies` in `managed-agents-adapter` uses `"*"` for `@codespar/types`. Same pattern as the new core entry. Consistent within itself, but at odds with the broader adapter cohort that pins peers at caret.
- `@codespar/sdk` is `dependencies`, not `peerDependencies`. That is correct — `@codespar/sdk` is a concrete runtime dependency of the SDK, not a peer to be supplied by the consumer. `@codespar/types` is a re-exported public surface (`packages/core/src/index.ts` does `export * from "@codespar/types"`). Re-exporting argues even more strongly for a tight range, since dual-resolution (consumer's `@codespar/types` and SDK's `@codespar/types` differing) would produce confusing TypeScript errors at consumer build time. Advisory.

## Findings

**Blocking (0):** none. The fix is functionally correct, the lockfile is clean, the dep direction is preserved, and the CI guard is in the right file.

**Advisory (3):**

1. `"@codespar/types": "*"` in `packages/core/package.json` dependencies is the loosest possible range for a re-exported contract package. Prefer `"^0.7.0"` to match the workspace adapter convention (`peerDependencies` pin to current minor). Tracker: see existing follow-up task #7 ("File follow-up issue for sub-1.0-caret across 13 adapters") — fold this into that issue.
2. PR description claim that `"*"` matches "every adapter's peerDeps" is inaccurate — only `managed-agents-adapter` uses `"*"` in peerDeps. Worth correcting in the PR body so the convention isn't enshrined incorrectly by future readers.
3. Layer A is subsumed by Layer B; kept for error-message quality. Acceptable. If/when this file grows, consider collapsing into a single check with a richer post-failure analyzer script under `scripts/`.
