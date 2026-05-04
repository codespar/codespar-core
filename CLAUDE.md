# CodeSpar Core — Project Instructions

## What this repo is

The public, MIT-licensed SDK layer of CodeSpar: the TypeScript
`@codespar/sdk` npm package, the `codespar` Python package on PyPI,
and the framework adapters that wrap them (Vercel AI SDK, Claude Agent
SDK, OpenAI Agents SDK, MCP, CLI). Everything here is a client-side
adapter over the managed-tier backend at `api.codespar.dev`; the
backend lives in `codespar-enterprise` (private).

Post-pivot (April 2026), CodeSpar is **commerce infrastructure for AI
agents in Latin America**. These SDKs encode the wire contract that
lets developers ship commerce agents (Pix + NF-e + WhatsApp + PSPs)
without rebuilding the plumbing. See
[`VISION-codespar.md`](https://github.com/codespar/codespar-web/blob/main/docs/visions/VISION-codespar.md)
for the strategic context.

## Authoritative context

- **Strategy**: VISION-codespar.md (in `codespar-web`, Accepted
  2026-04-19). Read it before making strategic decisions.
- **Wire contract**: every SDK method here maps 1:1 to a Fastify route
  in `codespar-enterprise/packages/api/src/routes/`. Do not edit the
  TS types without updating the Python package and backend together —
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
| `codespar/codespar-enterprise` (private) | Managed-tier backend + governance |
| `codespar/codespar-web` (private) | Marketing site + dashboard UI |

## Package Inventory (monorepo under `packages/`)

- **`core/`** → `@codespar/sdk` — canonical client. Sessions, managed
  auth, tool execution, Complete Loop.
- **`python/`** → `codespar` on PyPI (v0.1.1+). Same surface, sync +
  async flavours. Published via `.github/workflows/publish-python.yml`
  using PyPI trusted publishing (OIDC).
- **`types/`** → `@codespar/types`. Zero-dependency
  `SessionBase`/`Session` interface hierarchy + conformance tests.
  Shared contract between opensource runtime and managed-tier adapter.
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
  schema if the field is validated on client, (4) backend Fastify
  route in `codespar-enterprise`.
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
5. **Ship** — npm `publish` for TS packages; tag `python-v<version>`
   for PyPI.

## Internal docs

- `docs/tool-router.md` — Tool Router concept (public).
- `docs/custom-session-runtime.md` — `SessionBase` implementation guide (public).
- `docs/daniel-onboarding.md` (if present) — co-dev onboarding.
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
