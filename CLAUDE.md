# CodeSpar Core — Project Instructions

## What this repo is

The public, MIT-licensed SDK layer of CodeSpar: the TypeScript
`@codespar/sdk` npm package, the `codespar` Python package on PyPI,
and the framework adapters that wrap them (Vercel AI SDK, Claude Agent
SDK, OpenAI Agents SDK, MCP, CLI). Everything here is a client over
the CodeSpar API (default endpoint `api.codespar.dev`); the same SDK
also runs against a self-hosted runtime — `baseUrl` is a configuration
change.

Post-pivot (April 2026), CodeSpar is **commerce infrastructure for AI
agents in Latin America**. These SDKs encode the wire contract that
lets developers ship commerce agents (Pix + NF-e + WhatsApp + PSPs)
without rebuilding the plumbing. Read the project VISION for the
strategic context.

## Authoritative context

- **Strategy**: read the project VISION before making strategic
  decisions.
- **Wire contract**: every SDK method here maps 1:1 to a backend route.
  Keep the TS types, the Python package, and the backend in lockstep —
  drift between SDKs is the loudest way to break trust.
- **Current SDK shape**: `CodeSpar.create(userId, { preset, servers,
  manageConnections, projectId, metadata })` returns a `Session`
  exposing `tools`, `execute`, `proxyExecute`, `send`, `sendStream`,
  `authorize`, `connections`, `close`.

## Language
- Code, comments, file names, docs: **English**
- Conversation with user: **Portuguese**

## Repository Map

| Repo | Role |
|------|------|
| **`codespar-core`** (this repo, public MIT) | SDK + adapters (TS + Python) |
| `codespar/codespar` (public, MIT) | Self-hostable runtime + channel adapters |
| `codespar/mcp-dev-latam` (public, MIT) | LATAM MCP server catalog |

A private managed tier serves the same session contract.

## Package Inventory (monorepo under `packages/`)

- **`core/`** → `@codespar/sdk` — canonical client. Sessions, managed
  auth, tool execution, Complete Loop.
- **`python/`** → `codespar` on PyPI (v0.1.1+). Same surface, sync +
  async flavours. Published via `.github/workflows/publish-python.yml`
  using PyPI trusted publishing (OIDC).
- **`types/`** → `@codespar/types`. Zero-dependency
  `SessionBase`/`Session` interface hierarchy + conformance tests.
  Shared contract between the open-source runtime and the managed
  backend.
- **`managed-agents-adapter/`** → `@codespar/managed-agents-adapter`.
  Runs `SessionBase` tools against Anthropic Managed Agents sessions.
- **`vercel/` / `claude/` / `openai/`** — framework adapters.
- **`mcp/`** → `@codespar/mcp`. Emits config files for Claude Desktop,
  Cursor, VS Code clients pointing at a session's MCP endpoint.
- **`cli/`** → `@codespar/cli`. Auth + execute + session + scaffold
  commands. Entry `codespar-cli`.

Several adapter READMEs (`mastra`, `langchain`, `letta`, `camel`,
`llama-index`, `crewai`, `google-genai`, `autogen`) describe a
`cs.sessions.create(...)` API that does NOT exist in `packages/core`.
Pre-existing drift — safe to fix when you're already editing the file
for another reason; do not rewrite proactively.

## 2-level tenancy (Org → Project)

Shipped in SDK v0.2.2+. Every request carries `x-codespar-project` when
the caller sets `projectId` on the client or per-session. Precedence:
`sessionConfig.projectId > clientConfig.projectId > undefined` (backend
falls back to org default). Format: `/^prj_[A-Za-z0-9]{16}$/` — Zod
schema in `packages/core/src/types.ts` validates on create.

## Tech Stack

- **TypeScript 5.4+ strict** across every TS package.
- **`@codespar/sdk`**: zero runtime deps (uses native `fetch`).
- **`codespar` (Python)**: single runtime dep (`httpx>=0.27`). Python
  3.10+ required; strict `mypy` + `ruff` in CI.
- **Build**: Turborepo. Adapters build via `tsup`.
- **Tests**: Vitest for TS, pytest + pytest-httpx for Python.

## Publishing

- **npm**: manual via `npm publish` in each package dir (2FA required).
  Adapters track `@codespar/sdk` major version.
- **PyPI**: `gh release create python-v<version>` →
  `.github/workflows/publish-python.yml` runs lint + mypy + pytest +
  build + twine check + upload via trusted publishing. No long-lived
  API tokens in repo secrets.
- **Helper**: `bash scripts/publish.sh` walks the 3-stage ceremony
  (types → sdk → python) with 2FA prompts and propagation gates. See
  [`docs/PUBLISHING.md`](docs/PUBLISHING.md) for the full runbook +
  recovery flow. Run `--dry-run` first to preview.

## Coding Conventions

- Public types in `packages/core/src/types.ts` are the source of truth
  for wire shapes. Adding a new field requires matching updates in:
  (1) TS `types.ts`, (2) Python `src/codespar/types.py`, (3) Zod
  schema if the field is validated on client, (4) the backend route.
- File names: kebab-case. Classes / types: PascalCase. Functions:
  camelCase in TS, snake_case in Python.
- No comments explaining WHAT the code does; reserve for non-obvious
  WHY (e.g. protocol quirks, race-safety notes).
- `CodeSparConfig.apiKey` must start with `csk_` (staging) or
  `csk_live_` (prod) — validated at construction.

## Workflow

1. **Explore** — find where the wire shape lives in both TS + Python +
   backend before editing.
2. **Plan** — any shape change is a 3-way edit; flag it in the PR
   title.
3. **Implement** — start with types, then implementation, then tests.
4. **Verify** — `npm test` in affected package + `pytest` for Python.
   TS typecheck must pass (`npx tsc --noEmit`); Python mypy strict
   must pass.
5. **Live LLM smoke** (REQUIRED before pushing changes that touch the
   chat loop, tool catalog, system prompt, `session.send()`, or
   anything an `examples/*` directory consumes from those surfaces).
   The aimock-driven default tests cannot catch tool-name regex
   violations, invalid model ids, or system-prompt issues that only
   surface against real `api.anthropic.com`. Run BOTH examples:

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... \
     (cd examples/pix-nfse-skeleton && npm run validate:live) && \
     (cd examples/nfse-from-natural-language && npm run validate:live)
   ```

   Costs a few cents per run. Not wired into CI — too expensive and
   too probabilistic for every PR — but mandatory before pushing
   chat-loop-adjacent changes. The live smoke is what caught the
   tool-name `/` separator bug and the `claude-3-5-sonnet-latest`
   model id bug that all aimock tests passed through unchallenged.
6. **Ship** — npm `publish` for TS packages; tag `python-v<version>`
   for PyPI.

## Internal docs

- `docs/tool-router.md` — Tool Router concept (public).
- `docs/custom-session-runtime.md` — `SessionBase` implementation guide (public).
- `docs/repo-map.md` — cross-repo architecture.

## What NOT to do

- NEVER let TS + Python + backend drift on the wire contract.
- NEVER add a runtime dependency to `packages/core` (zero-dep constraint
  is part of the SDK's appeal).
- NEVER expose `apiKey` in examples without `process.env.CODESPAR_API_KEY`
  wrapping — the docs-by-example pattern must teach the right habits.
- NEVER rewrite the adapter READMEs' phantom `cs.sessions.create(...)`
  API proactively — it's pre-existing drift; fix when editing for
  another reason.
- NEVER commit to `main` without `npm test` + `npx tsc --noEmit` green.

## Quick Commands

- **QPLAN** — survey the SDK surface + both languages, propose the
  change with tradeoffs. Do not code yet.
- **QCODE** — implement. Verify TS + Python + backend stay aligned.
- **QCHECK** — skeptical review: wire-contract drift, missing tests,
  adapter-specific edge cases.
- **QTEST** — `npm test` (Vitest) + `pytest` in `packages/python`.
- **QSTATUS** — npm version + PyPI version + unreleased changes per
  package.
