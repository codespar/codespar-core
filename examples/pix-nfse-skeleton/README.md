# Pix + NFS-e walking skeleton

A 4-step end-to-end validation of the OSS MCP bridge:

1. `asaas/create_customer`
2. `asaas/create_payment` (Pix, R$150)
3. `asaas/get_pix_qrcode`
4. `nuvem-fiscal/create_nfse`

The chain's tool responses come from per-test fixtures declared inline via
the `mocks` field on `cs.create()` — no real Asaas account or Nuvem Fiscal
credential is required. The runtime's test-mode dispatch seam intercepts
each tool call before the MCP bridge and returns the matching fixture.

## What this is, and what it isn't

**This is infrastructure validation, not an agent-thesis demo.** The SDK's
deterministic `loop()` orchestrates the four tools in a fixed order; there
is no LLM in the picture, no judgment on which tool to call next, no
multi-turn conversation. The point is to prove the wire from
`@codespar/sdk` → bridge → spawned MCP children → fixture payload comes
back round-trip clean. Everything that requires a *model* picking tools
lives in the sibling examples:

- [`nfse-from-natural-language/`](../nfse-from-natural-language/) — adds
  a single-turn LLM step on top of this wiring (`session.send()` instead
  of `loop()`).
- [`whatsapp-installment-negotiation/`](../whatsapp-installment-negotiation/)
  — adds multi-turn `session.send()` with aimock replacing Anthropic so
  the test stays deterministic.

The judgment points those demos exercise (which tool to call, what
arguments to extract from natural language, when to stop) do not exist
here. This file demonstrates that the runtime can dispatch a fixed
sequence; the others demonstrate that an agent can drive it.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Vitest spec — builds a `LoopConfig`, calls `loop(session, config)`, asserts the 6 invariants from §"Acceptance criteria" |
| `package.json` | Pins `@codespar/mcp-asaas` and `@codespar/mcp-nuvem-fiscal` so the servers spawn and the runtime registers their tool schemas |
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

1. **`CODESPAR_BASE_URL` is set** — uses the already-running runtime at that URL. No lifecycle management; you start/stop the runtime yourself. That runtime must have been started with `CODESPAR_TEST_MODE_ENABLED=true`, or `cs.create()` rejects the mocks payload with HTTP 501 `mocks_not_permitted`.
2. **`CODESPAR_RUNTIME_DIR` is set** — boots `node server/start.mjs` from that directory on port 3000 with `CODESPAR_TEST_MODE_ENABLED=true`, polls `/health` for up to 20s, runs `vitest`, then kills the runtime on exit. The clone must include the runtime's session-mocks support (commit `5830dc4` / PR #113 or later on `main`).
3. **`docker` is on PATH** — pulls and runs `ghcr.io/codespar/codespar:latest` with the example dir mounted at `/example` (so the bridge reads `./mcp-servers.json` from there) and `CODESPAR_TEST_MODE_ENABLED=true` wired in. This is the default path; no env vars required. The image must include session-mocks support (commit `5830dc4` / PR #113 or later).

If none of the above is available, the script prints setup instructions and exits non-zero. There's no implicit sibling-directory fallback — examples must work from any layout.

```bash
# Option A (recommended) — install Docker, then just run:
npm run validate

# Option B — point at a running runtime (you manage its lifecycle).
# It must have been started with CODESPAR_TEST_MODE_ENABLED=true.
export CODESPAR_BASE_URL=http://localhost:3000
npm run validate

# Option C — point at a local clone of codespar/codespar (the script
# manages it, in test mode):
git clone https://github.com/codespar/codespar.git /tmp/codespar
(cd /tmp/codespar && git checkout main && npm install && npx turbo run build)
export CODESPAR_RUNTIME_DIR=/tmp/codespar
npm run validate

# Pin a specific runtime image instead of :latest:
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:latest
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

This demo's mockability has a single stub layer. Because the steps are
explicit and no LLM picks tools, there is no LLM-stub layer here — only
the tool-stub layer and the live path:

| Layer | This demo |
|---|---|
| Tool stub | `mocks` API on `cs.create()` |
| Live | real Asaas + real Nuvem Fiscal |

- The fixtures live **in the test**, declared inline on
  `cs.create({ servers, mocks })`. The runtime's test-mode dispatch seam
  (`CODESPAR_TEST_MODE_ENABLED=true`) intercepts every external tool call
  before the MCP bridge and returns the matching fixture. A tool the loop
  calls without a matching mock entry fails as `tool_not_mocked` — strict
  by definition, no fallthrough to a real provider.
- This exercises a **real session + real bridge** with mocked tool
  responses; it does not use `@codespar/sdk/testing`'s `fakeSession()`,
  which bypasses the bridge entirely.
- The MCP server packages still support a `--demo` flag for their own
  internal testing, but the customer-facing pedagogy is the `mocks` API:
  you get per-test fixture pinning instead of trusting each server's
  demo-handler.
- Mocks are the on-ramp, not the destination. Dropping
  `CODESPAR_TEST_MODE_ENABLED` and setting real `ASAAS_API_KEY` /
  `NUVEM_FISCAL_*` credentials runs the same code against live APIs. The
  test code does not branch on test mode.

## Acceptance criteria

The vitest spec asserts these per-step invariants, each pinned by the
inline `mocks` fixtures declared in `skeleton.test.ts`:

1. **Aggregate** — `result.success === true`, `result.completedSteps === 4`,
   every `result.results[i].success === true`.
2. **Step 1 — `asaas/create_customer`** — `data.id` matches `/^cus_demo_/`.
3. **Step 2 — `asaas/create_payment`** — `data.id` matches `/^pay_demo_/`,
   `data.billingType === "PIX"`, `data.value === 150.0`, `data.customer`
   is a string (the id returned by step 1 round-tripped through the
   bridge).
4. **Step 3 — `asaas/get_pix_qrcode`** — `data.payload` matches
   `/^00020126/` (the BR-Code static-EMV envelope header that real Pix
   QR strings always start with) and `data.encodedImage` is a non-empty
   string.
5. **Step 4 — `nuvem-fiscal/create_nfse`** — `data.id` matches
   `/^nfse_demo_/`, `data.status === "autorizada"`, `data.numero` and
   `data.valorServico` are numbers.

Promoting these from count-and-shape checks to per-call arg + output
assertions catches the regressions that matter for a wire-contract demo:
silently swapping the demo fixture for a different shape, the bridge
mangling field names, or the `loop()` step ordering drifting.

## Live LLM smoke (`npm run validate:live`)

`validate.sh` exercises the deterministic `loop()` against demo MCP servers — there is no real Anthropic call. To also verify the agentic path through the OSS chat loop (real `api.anthropic.com`, real tool-name regex, real model id), run:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run validate:live
```

That boots a runtime with your `ANTHROPIC_API_KEY` (no aimock), runs `live.test.ts`, and tears down. The live path points the runtime at a separate `mcp-servers.live.json` (via `CODESPAR_MCP_SERVERS_PATH`) that re-injects the MCP `--demo` flag, so no Asaas / Nuvem-Fiscal credentials are needed; the test-mode path (`validate.sh`) uses the default `mcp-servers.json` and stubs at the runtime layer via `cs.create({ mocks })`. Two paths, two configs, one cleanly-split dependency surface. The live test sends a natural-language prompt that asks Claude to orchestrate the four-step flow itself (create Asaas customer → Pix charge → fetch QR → issue NFS-e); the assertions stay coarse (at-least-one Asaas dispatch, at-least-one Nuvem-Fiscal dispatch, every dispatched call succeeds) because real Claude is probabilistic.

This is **not in CI** — it costs real Anthropic spend (a few cents per run) and is probabilistic enough that flakes would be noise. Run it locally before pushing changes that touch the OSS chat loop, the tool catalog, the SDK's `session.send()`, the LATAM-commerce system prompt, or this example's MCP fixtures. The aimock-mode tests can't catch tool-name regex violations or invalid model ids; only this can.

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
