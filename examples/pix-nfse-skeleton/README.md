# Pix + NFS-e walking skeleton

A 4-step end-to-end validation of the OSS MCP bridge: `asaas/create_customer
→ asaas/create_payment → asaas/get_pix_qrcode → nuvem-fiscal/create_nfse`.
The whole loop runs against the published `@codespar/mcp-*` packages with
their `--demo` flag, so no real Asaas account or Nuvem Fiscal credential
is required.

This example is **infrastructure validation** for the SDK's wire to the
OSS bridge. It is not an agent-thesis demo — no LLM, no commerce
governance, no commercial memory.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Vitest spec — builds a `LoopConfig`, calls `loop(session, config)`, asserts the 6 invariants from §"Acceptance criteria" |
| `package.json` | Pins `@codespar/mcp-asaas` and `@codespar/mcp-nuvem-fiscal` exactly so demo-fixture drift surfaces explicitly |
| `mcp-servers.json` | Server registry consumed by the bridge — flat object, `command: string[]`, `transport: "stdio"` |
| `scripts/validate.sh` | Boots the OSS runtime, polls `/health`, runs vitest, kills the runtime on exit |
| `tsconfig.json` | Minimal TS config (NodeNext, strict, vitest globals) |
| `.gitignore` | `node_modules/`, `dist/` |

## Two run paths

### OSS (self-hosted runtime)

```bash
cd examples/pix-nfse-skeleton
npm install
npm run validate
```

`validate.sh` picks one of three runtime sources, first match wins:

1. **`CODESPAR_BASE_URL` is set** — uses the already-running runtime at that URL. No lifecycle management; you start/stop the runtime yourself.
2. **`CODESPAR_RUNTIME_DIR` is set** — boots `node server/start.mjs` from that directory on port 3000, polls `/health` for up to 20s, runs `vitest`, then kills the runtime on exit.
3. **`docker` is on PATH** — pulls and runs `ghcr.io/codespar/codespar:latest` with the example dir mounted at `/example` (so the bridge reads `./mcp-servers.json` from there and resolves the spawned MCP server paths against the example's installed `node_modules`). This is the default path; no env vars required.

If none of the above is available, the script prints setup instructions and exits non-zero. There's no implicit sibling-directory fallback — examples must work from any layout.

```bash
# Option A (recommended) — install Docker, then just run:
npm run validate

# Option B — point at a running runtime (you manage its lifecycle)
export CODESPAR_BASE_URL=http://localhost:3000
npm run validate

# Option C — point at a local clone of codespar/codespar (the script manages it)
git clone https://github.com/codespar/codespar.git /tmp/codespar
(cd /tmp/codespar && npm install && npx turbo run build)
export CODESPAR_RUNTIME_DIR=/tmp/codespar
npm run validate

# Pin a specific runtime image instead of :latest:
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:v0.1.0
npm run validate
```

### Managed (api.codespar.dev)

```bash
cd examples/pix-nfse-skeleton
CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx \
CODESPAR_BASE_URL=https://api.codespar.dev \
  npm test
```

The managed runtime decides demo vs. live based on the API key prefix
(`csk_test_` → demo project semantics), so no `MCP_DEMO` env is needed
on this path.

> Production API keys carry the `csk_live_` prefix. They never appear in
> copy-paste documentation; using them in an example would risk a real
> charge or NF-e issuance against a developer's account by accident.

## What backs the fixture path

This example exercises a **real session + real bridge + spawned MCP
children running with `--demo`**. It does not use
`@codespar/sdk/testing`'s `fakeSession()`.

- The demo-mode mock lives **inside each MCP server**
  (`@codespar/mcp-asaas`, `@codespar/mcp-nuvem-fiscal`), not inside the
  SDK. `fakeSession()` bypasses the bridge entirely; this example
  exercises it.
- `MCP_DEMO=true` is data-driven, not magic — the `--demo` flag on the
  `command` array in `mcp-servers.json` is the source of truth. The
  spawned MCP server reads the flag and returns deterministic fixtures.
- Demo mode is the on-ramp, not the destination. Removing `--demo` and
  setting real `ASAAS_API_KEY` / `NUVEM_FISCAL_*` credentials runs the
  same code against live APIs. The test code does not branch on demo
  mode.

## Acceptance criteria

The vitest spec asserts six invariants pulled from the demo fixtures in
`@codespar/mcp-asaas` and `@codespar/mcp-nuvem-fiscal`:

1. `result.success === true`
2. `result.completedSteps === 4`
3. `result.results[0].success === true` (`asaas/create_customer`)
4. `result.results[1].data.id` matches `/^pay_/`
5. `result.results[2].data.payload.length > 0`
6. `result.results[3].data.id` matches `/^nfse_/` AND
   `result.results[3].data.status === "autorizada"`

## Known platform gaps

Flagged here so they survive as latent debt rather than getting lost in
review comments:

1. **Bootstrap ergonomics asymmetry.** The OSS bridge takes its server
   registry via a file (`mcp-servers.json` on cwd) while the SDK is
   configured inline via `cs.create()`. A future iteration should let
   `cs.create({ server_specs: [...] })` push specs through the wire so
   examples can be single-file. Until then, the file is the surface.
2. **Two-process orchestration overhead.** The example needs the
   runtime in one process and the test in another. `validate.sh`
   papers over that for first-run; collapsing this (e.g. an in-process
   bridge package) would meaningfully lower the bar to writing more
   skeleton tests.
3. **`csk_test_` / `csk_live_` key-prefix safety.** This README uses
   `csk_test_` everywhere. The repo would benefit from a documented
   invariant that copy-paste docs must not include `csk_live_`, so
   regressions get caught at lint time.
