# PLAN-p3 — Walking Skeleton (Pix + NFS-e) for codespar-core

| Field | Value |
|---|---|
| Source issue | [codespar-web#326](https://github.com/codespar/codespar-web/issues/326) |
| Target repo | `codespar-core` (this repo) |
| Target path | `examples/pix-nfse-skeleton/` (net-new) |
| Phase | P3 from `ROADMAP-demo-series.md` |
| Complexity | `testable` |
| Plan shape | Single PR, single PLAN doc — `wip/PLAN-p3.md` (this file) cleaned before merge |
| Verdict (from Phase 1) | direct-implement — no PRD, no DESIGN |
| Scope | OSS-only infrastructure validation. NOT an agent-thesis demo |

All 6 sub-decisions are pre-approved at coordinator-recommended defaults. Re-litigation is out of scope; the values are restated below only to anchor the implementation choices.

---

## 1. Sub-decision anchors (pre-approved, do not re-open)

| ID | Decision | Notes for /work-on |
|---|---|---|
| SD-1 | MCP bridge config surface = inline `server_specs` on `cs.create()` **only if** the public TS signature in `packages/core/src/types.ts` supports it. **Today it does not** (`SessionConfig.servers: string[]` is server-ids-only; `presetToServers()` confirms — see `packages/core/src/session.ts:563-566`). Fallback applies: ship `mcp-servers.json` inside `examples/pix-nfse-skeleton/`. The runtime is started from the example directory so that file is on the runtime's cwd. NEVER instruct users to edit any file outside the example directory. |
| SD-2 | `@codespar/mcp-asaas` + `@codespar/mcp-nuvem-fiscal` are `devDependencies` in the example's `package.json` (specific version pinned, latest stable at PR time). `mcp-servers.json` points the spawn command at `./node_modules/@codespar/mcp-asaas/bin/...` (resolved via `node`). NOT `npx -y`, NOT global. |
| SD-3 | `MCP_DEMO` is enabled by passing `--demo` in each MCP server's spawn `args` in `mcp-servers.json`. The runtime's env is NOT a dependency. The `MCP_DEMO=true` env variable in run commands is retained for parity with the issue body, but it is informational only — the source of truth for demo mode is the `--demo` flag visible on the spawn line in `mcp-servers.json`. |
| SD-4 | `scripts/validate.sh` is shipped inside `examples/pix-nfse-skeleton/`. It formalizes the issue body's Validation block: boots the runtime in the background, polls `/health`, runs `vitest`, kills the runtime on exit. NOT docker-compose. NOT README-only. |
| SD-5 | README's managed-platform run command uses `csk_test_...` (NEVER `csk_live_...`). An educational aside explains `csk_live_` exists for production but should never appear in copy-paste docs that may be run unsupervised. |
| SD-6 | The fixture path is **real session + real bridge + spawned MCP server children running with `--demo`**. NOT `@codespar/sdk/testing`'s `fakeSession()`. Re-state in the README under "What backs the fixture path" so a reader following from `ROADMAP-demo-series.md` lands on the same mental model. |

---

## 2. What backs the fixtures (single source of truth)

P3 assertions are matched against the literal demo payloads emitted by the MCP servers in `mcp-dev-latam` when spawned with `--demo`. **No fixtures are authored in this PR.** The mapping below is the contract `/work-on` must honor; if any payload shape changes, the bug is in `mcp-dev-latam`, not in this example.

| Step | Tool | Demo payload (from `mcp-dev-latam`) | Assertion |
|---|---|---|---|
| 0 | `asaas/create_customer` | `{ id: "cus_demo_001", ... }` | `result.results[0].success === true` |
| 1 | `asaas/create_payment` | `{ id: "pay_demo_001", ... }` | `/^pay_/.test(result.results[1].data.id)` |
| 2 | `asaas/get_pix_qrcode` | `{ payload: "<non-empty>", ... }` | `result.results[2].data.payload.length > 0` |
| 3 | `nuvem-fiscal/create_nfse` | `{ id: "nfse_demo_001", status: "autorizada", ... }` | `/^nfse_/.test(result.results[3].data.id)` AND `result.results[3].data.status === "autorizada"` |

Plus the loop-level invariants:
- `result.success === true`
- `result.completedSteps === 4`

Step 1 threads `customerId` from step 0 via the `params: (prev) => ({ customer: prev[0].data.id, ... })` form documented at `packages/core/src/types.ts:50-57`. Step 2 threads `paymentId` from step 1 the same way. Step 3 is independent (no prior-step id required by the demo fixture).

---

## 3. Files to create

All paths are relative to repo root.

### 3.1 `examples/pix-nfse-skeleton/skeleton.test.ts`
The vitest spec. Single `describe("P3 walking skeleton")` with a single `it("runs the 4-step loop end-to-end against the demo bridge")`. Builds the `LoopConfig`, calls `loop(session, config)`, makes the 6 assertions from §2, calls `session.close()` in `afterAll`. No retries — demo fixtures are deterministic; `retryPolicy` is omitted. `abortOnError: true` (default) so the first failure surfaces in vitest output rather than a silent skip.

Test reads `CODESPAR_API_KEY` and `CODESPAR_BASE_URL` from `process.env`. Defaults: `CODESPAR_API_KEY=local` (OSS sentinel — the runtime ignores it), `CODESPAR_BASE_URL=http://localhost:3000`. Both env reads happen at module top to fail fast with a readable error if missing.

Imports: `CodeSpar`, `loop`, `LoopConfig` from `@codespar/sdk`. No type-only imports from `@codespar/types` are required for the test surface, but the assertions use casts like `(r.data as { id: string }).id` — same pattern as `examples/latam-commerce-smoke/smoke-test.ts:129`.

### 3.2 `examples/pix-nfse-skeleton/package.json`
```jsonc
{
  "name": "@codespar/example-pix-nfse-skeleton",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "skeleton": "vitest run --reporter=verbose",
    "validate": "./scripts/validate.sh"
  },
  "dependencies": {
    "@codespar/sdk": "file:../../packages/core"
  },
  "devDependencies": {
    "@codespar/mcp-asaas": "<pin to latest stable>",
    "@codespar/mcp-nuvem-fiscal": "<pin to latest stable>",
    "vitest": "^2.0.0",
    "typescript": "^5.4.0"
  }
}
```
Pinning the two MCP packages: `/work-on` resolves the current published version with `npm view @codespar/mcp-asaas version` and `npm view @codespar/mcp-nuvem-fiscal version`, then uses an exact pin (no caret) because demo-fixture shapes are the contract and a minor bump that changes them is a contract break we want to surface explicitly, not absorb silently.

### 3.3 `examples/pix-nfse-skeleton/mcp-servers.json`
Two entries: `asaas` and `nuvem-fiscal`. Each spawn entry includes `--demo` in `args` (SD-3). Example shape — exact field names follow whatever `codespar/codespar`'s OSS bridge from PR #103 reads (`/work-on` confirms by reading the bridge loader in the sibling worktree before implementing):
```jsonc
{
  "servers": {
    "asaas": {
      "command": "node",
      "args": ["./node_modules/@codespar/mcp-asaas/dist/bin.js", "--demo"]
    },
    "nuvem-fiscal": {
      "command": "node",
      "args": ["./node_modules/@codespar/mcp-nuvem-fiscal/dist/bin.js", "--demo"]
    }
  }
}
```
Field name `command`/`args` is illustrative — `/work-on` reads the bridge's schema from `codespar/codespar` (PR #103) and aligns. The plan's invariant is "explicit `--demo` flag in spawn args, no env reliance"; the JSON key names are the runtime's contract.

### 3.4 `examples/pix-nfse-skeleton/scripts/validate.sh`
Adapted from the issue body. Differences from the issue's literal script:
- Resolve the codespar runtime path via `CODESPAR_RUNTIME_DIR` env var; fall back to `../../../codespar` (sibling of `codespar-core` in the standard workspace layout). Fail fast with a one-line message if neither resolves.
- Run from `$SKELETON_DIR` always (no `cd` to workspace root) so the script is portable across workspace layouts.
- `set -euo pipefail` + `trap` to ensure the background runtime is killed on script exit, including SIGINT.
- `MCP_DEMO=true` env on the test step is retained for parity with the issue, but a `# Source of truth: --demo in mcp-servers.json` comment makes the SD-3 anchor visible at the point of confusion.
- Poll `/health` for up to 20s in 1s increments, same as the issue.

### 3.5 `examples/pix-nfse-skeleton/README.md`
Sections, in order:

1. **What this is** — one paragraph: this is infrastructure validation for the OSS MCP bridge, not an agent-thesis demo. Cites `ROADMAP-demo-series.md` P3.
2. **Two run paths** — the OSS local-runtime path and the managed-platform path. Both commands use `csk_test_` for the managed path per SD-5. Educational aside: `csk_live_` exists for production but never appears in copy-paste examples.
3. **What backs the fixture path (not `fakeSession()`)** — explicit re-statement of SD-6. Three points:
   - Demo-mode mock lives **in the MCP server** (`@codespar/mcp-asaas`, `@codespar/mcp-nuvem-fiscal`), NOT in `@codespar/sdk/testing`. `fakeSession()` bypasses the bridge entirely; this example exercises the bridge.
   - `MCP_DEMO=true` is data-driven, not magic — the spawn line in `mcp-servers.json` carries `--demo`, the MCP server reads the flag and returns deterministic fixtures shaped per the table in §2.
   - Demo mode is the on-ramp, not the destination — flipping the `--demo` flag off plus setting real `ASAAS_API_KEY` / `NUVEM_FISCAL_*` credentials runs the same test against live APIs. The test code does not branch on demo mode.
4. **Run instructions** — exact commands:
   - OSS: `npm install && npm run validate` (runs `validate.sh`)
   - OSS manual (two-terminal): start runtime in `codespar` repo with `npm start`, then `MCP_DEMO=true CODESPAR_BASE_URL=http://localhost:3000 npm test` here
   - Managed: `CODESPAR_API_KEY=csk_test_... CODESPAR_BASE_URL=https://api.codespar.dev npm test`
5. **Acceptance criteria** — link to issue #326. List the 6 assertions verbatim so a reader doesn't have to context-switch.
6. **Known platform gaps** — see §5 of this plan.

### 3.6 `examples/pix-nfse-skeleton/tsconfig.json`
Match `examples/latam-commerce-smoke/`-style minimal `tsconfig.json` (extends root, sets `module`/`target`). `/work-on` copies the latam-commerce-smoke variant verbatim if one exists; otherwise creates a minimal `{ "extends": "../../tsconfig.json", "include": ["**/*.ts"] }`.

### 3.7 `examples/pix-nfse-skeleton/.gitignore`
`node_modules/`, `dist/`. Mirrors other examples.

---

## 4. Verification path

### 4.1 OSS path (the canonical run)
```bash
cd examples/pix-nfse-skeleton
npm install
npm run validate
```
Expected: `validate.sh` boots the runtime in background, waits for `/health` ≤ 20s, runs `npm test`, kills the runtime, exits 0. vitest reports `1 passed`.

### 4.2 OSS manual path (two terminals)
Documented in README, used when iterating. Verifies the test process and runtime process are properly decoupled — same command will be reused by anyone integrating against the bridge for unrelated work.
```bash
# terminal 1 — runtime
cd <CODESPAR_RUNTIME_DIR>
npm start

# terminal 2 — test
cd examples/pix-nfse-skeleton
MCP_DEMO=true CODESPAR_BASE_URL=http://localhost:3000 npm test
```

### 4.3 Managed-platform path
```bash
cd examples/pix-nfse-skeleton
CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx CODESPAR_BASE_URL=https://api.codespar.dev npm test
```
No `MCP_DEMO` env required — the managed runtime decides demo vs. live based on the API key prefix (`csk_test_` → demo project semantics). The test code is unchanged.

### 4.4 Repo-level checks before merge
- `npm install` at repo root (Turborepo workspace resolution): the new example shouldn't trip the workspace install.
- `npx tsc --noEmit -p packages/core`: ensure the example didn't accidentally trigger a SDK type regression.
- `npm test` in `packages/core`: existing Vitest suite must still pass.
- `cd examples/pix-nfse-skeleton && npm test` against a running OSS bridge — must pass.

No Python work in this PR. No `mcp-dev-latam` work in this PR. No wire-contract change. CLAUDE.md's "3-way edit" rule (TS + Python + backend) does not apply — this is consumer code only.

---

## 5. Platform gaps to flag in the PR description

Three gaps surfaced in Phase 1 must be called out in the PR body so they're not lost as latent debt:

1. **Bootstrap ergonomics asymmetry** — the OSS bridge takes config via a file (`mcp-servers.json` on cwd) while the SDK is configured inline via `cs.create()` args. A future iteration should let `cs.create({ server_specs: [...] })` push specs through the wire so the example can be a single-file run (`smoke-test.ts` + `package.json`). Until then, the file is the surface.
2. **Two-process orchestration overhead** — running the example requires the runtime in one process and the test in another. `validate.sh` papers over the friction for first-run, but DX work to collapse this (e.g. a `--inline-runtime` flag on `vitest` setup, or a `@codespar/test-runtime` package that boots an in-process bridge) would meaningfully lower the bar to writing more skeleton tests.
3. **`csk_test_` / `csk_live_` key-prefix safety** — already corrected in `ROADMAP-demo-series.md` via #388. This PR honors that correction (README uses `csk_test_`). The gap is the lack of a documented invariant in the SDK that copy-paste docs must not include `csk_live_`. A lint rule on the docs directory or a CONTRIBUTING.md note would prevent regression.

---

## 6. Open questions for coordinator

1. **Exact pins for MCP package devDeps** — `/work-on` will resolve `@codespar/mcp-asaas` and `@codespar/mcp-nuvem-fiscal` current versions and pin exactly. Should the plan instead defer to a workspace `file:` link if those packages are checked out as siblings in standard layout? Default position: stick with npm exact pins. The example's purpose is to validate the bridge against published demo fixtures, not against in-development MCP code. A `file:` link would silently capture local edits and obscure fixture drift.
2. **`mcp-servers.json` schema field names** — illustrative in §3.3; `/work-on` reads `codespar/codespar` PR #103's loader before writing the file. Coordinator: confirm `/work-on` is authorized to read across `../../../codespar/` to extract the schema, OR that the schema is documented somewhere in the public `codespar` repo that's already in the work-on context.
3. **Should `validate.sh` be POSIX `sh` or `bash`?** — the issue body uses `#!/usr/bin/env bash` with `set -euo pipefail`. Default position: keep `bash`; macOS Catalina+ ships bash 3.2 but the script needs nothing beyond `set -euo pipefail` + `trap`, which 3.2 supports. Flag only if the team has a portability preference.

---

## 7. What `/work-on` MUST NOT do

- Author MCP_DEMO fixtures (they exist in `mcp-dev-latam` and match every assertion).
- Modify `packages/core/src/types.ts` or any SDK code (this is a consumer-only example).
- Add commercial-tier dependencies — no wallet, no policy hooks, no audit chain, no commercial memory, no `codespar-enterprise` import.
- Touch wire contracts (no Python, no `@codespar/api-types`, no Fastify route).
- Edit `ROADMAP-demo-series.md` or `DESIGN-demo-scaffold.md` — both already corrected on `main` (#388).
- Add `csk_live_` to any committed file. (Lint check before commit.)
- Run `/work-on` dispatch from within this plan — coordinator review gate.

---

## 8. Stopping rule and handoff

This plan is the artifact. Coordinator reviews. If approved, coordinator dispatches `/work-on` against this plan. `/work-on`'s job is mechanical — every architectural choice is resolved here.

Niwa task envelope contract (worker side):
```json
{
  "plan_shape": "single_pr_plan_doc",
  "plan_artifact_path_or_milestone_url": "wip/PLAN-p3.md",
  "files_to_create": [
    "examples/pix-nfse-skeleton/skeleton.test.ts",
    "examples/pix-nfse-skeleton/package.json",
    "examples/pix-nfse-skeleton/mcp-servers.json",
    "examples/pix-nfse-skeleton/scripts/validate.sh",
    "examples/pix-nfse-skeleton/README.md",
    "examples/pix-nfse-skeleton/tsconfig.json",
    "examples/pix-nfse-skeleton/.gitignore"
  ],
  "verification_commands_for_workon": [
    "cd examples/pix-nfse-skeleton && npm install",
    "cd examples/pix-nfse-skeleton && npm run validate",
    "npx tsc --noEmit -p packages/core",
    "cd packages/core && npm test"
  ],
  "open_questions_for_coordinator": [
    "Pin strategy for @codespar/mcp-asaas and @codespar/mcp-nuvem-fiscal — npm exact pin (default) vs sibling file: link",
    "/work-on authorization to read codespar repo PR #103 bridge loader schema for mcp-servers.json field names",
    "bash vs POSIX sh for scripts/validate.sh (default: bash)"
  ]
}
```
