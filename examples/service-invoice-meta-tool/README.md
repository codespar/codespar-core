# Service invoice at the meta-tool abstraction

A SaaS company's agent receives a WhatsApp message from a customer:

> *"Preciso de duas NFS-e: taxa de acesso à plataforma R$2.800 e
> consultoria de onboarding R$1.200. Envia os PDFs no WhatsApp."*

One call to `session.send(message)` later, the agent has:

1. Split the request into two distinct service lines (platform access
   and onboarding consulting) rather than one combined charge.
2. Issued two fiscal documents by calling the **`codespar_invoice`**
   meta-tool once per line.
3. Sent one WhatsApp message back by calling the **`codespar_notify`**
   meta-tool, carrying both NFS-e PDF URLs.

The agent works at the **commerce meta-tool abstraction**: it calls
`codespar_invoice` and `codespar_notify`, never a raw
`nuvem-fiscal__create_nfse` or `z-api__send_text`. That is the whole
point of this example. The meta-tool is the façade; how it routes to a
fiscal provider (Nuvem Fiscal) and a messaging provider (Z-API) is the
runtime's concern, not the agent's. The agent code stays at the meta-tool
layer, decoupled from any specific provider.

## The canonical scenario

The scenario and its assertion are not defined here — they are imported
from
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types),
the single source of truth this example consumes:

```ts
import { runDemoScenario, SERVICE_INVOICE_SCENARIO } from "@codespar/types/testing";

runDemoScenario(CODESPAR_BASE_URL, SERVICE_INVOICE_SCENARIO, { apiKey });
```

`SERVICE_INVOICE_SCENARIO` is the canonical scenario published in
`@codespar/types/testing`, paired with its aimock fixture set.
`runDemoScenario` drives the conversation over the `session.send()` path
and asserts, via `assertMetaToolTrace`, that every tool the agent called
was a meta-tool (`codespar_*`) with `status: "success"` — and that no raw
`serverId__tool` name appears in the trace.

## The core ships no built-in meta-tools — the demo opts in

`@codespar/core` exposes the `MetaToolHook` seam but registers nothing by
default, so this example brings its own. The `demo-plugin.mjs` file
registers `codespar_invoice` and `codespar_notify` (using the shared
definitions published from `@codespar/types`) through that seam, and the
runtime loads it at startup via the `CODESPAR_PLUGINS` environment
variable:

```js
import { INVOICE_DEFINITION, NOTIFY_DEFINITION } from "@codespar/types";

const hook = {
  id: "demo-service-invoice",
  handles: ["codespar_invoice", "codespar_notify"],
  definitions: () => [INVOICE_DEFINITION, NOTIFY_DEFINITION],
  async execute(name) {
    throw new Error(`meta-tool "${name}" reached the live path; this demo runs in test mode`);
  },
};

export default function register(registry) {
  registry.registerMetaTool(hook);
}
```

In test mode the session `mocks` (keyed on the meta-tool name) answer the
call before `execute()` ever runs, so this demo's `execute()` is a
deliberate tripwire — if it throws, the mock interception didn't fire. A
real deployment would implement `execute()` to route the meta-tool to its
providers; that live path is intentionally out of scope here.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Three lines: import `runDemoScenario` + `SERVICE_INVOICE_SCENARIO` from `@codespar/types/testing` and run them against `CODESPAR_BASE_URL`. The scenario and assertion live in the shared package, not here |
| `demo-plugin.mjs` | Registers `codespar_invoice` + `codespar_notify` as meta-tools via the `MetaToolHook` seam, using the shared `@codespar/types` definitions. Loaded by the runtime through `CODESPAR_PLUGINS` |
| `fixtures/aimock-fixtures.json` | Three-turn aimock fixture: turn 0 emits two `codespar_invoice` tool_use blocks; turn 1 emits one `codespar_notify` tool_use; turn 2 emits the final text summary |
| `scripts/validate.sh` | Boots aimock first, then resolves a runtime (already-running / local clone / docker) with test mode + the plugin loaded, polls `/health`, runs vitest, kills everything on exit |
| `package.json` | Pins `@codespar/types@^0.10.10` (scenario + definitions) and `@copilotkit/aimock` |
| `tsconfig.json` / `vitest.config.ts` | Minimal TS config + a 60s timeout (LLM-driven loops are slower than a deterministic skeleton) |
| `.gitignore` | `node_modules/`, runtime + aimock log/pid files, `.codespar/` |

There is no `mcp-servers.json` here. That file is the spawn recipe for
the **raw**-tool bridge; a meta-tool agent never touches it. The
underlying providers are reached (in production) by the meta-tool's own
`execute()`, not by the runtime spawning MCP servers the agent calls
directly.

## Run paths

```bash
cd examples/service-invoice-meta-tool
npm install
npm run validate
```

`validate.sh` always boots aimock on port 4010 first (the LLM stand-in),
then picks one of three runtime sources, first match wins:

1. **`CODESPAR_BASE_URL` is set** — uses the already-running runtime at
   that URL. The script does NOT manage its lifecycle, and that runtime
   must already be configured with `ANTHROPIC_BASE_URL=http://localhost:4010`,
   `CODESPAR_TEST_MODE_ENABLED=true`, and the demo plugin loaded via
   `CODESPAR_PLUGINS`.
2. **`CODESPAR_RUNTIME_DIR` is set** — boots `node server/start.mjs` from
   that directory on port 3000, with `ANTHROPIC_BASE_URL` pointed at the
   local aimock, `CODESPAR_TEST_MODE_ENABLED=true`, and
   `CODESPAR_PLUGINS` pointed at this dir's `demo-plugin.mjs`. Polls
   `/health`, runs vitest, tears down on exit.
3. **`docker` is on PATH** — runs the published image with the example
   dir mounted at `/example`, `--add-host=host.docker.internal:host-gateway`
   so the container reaches the host's aimock, `CODESPAR_TEST_MODE_ENABLED=true`,
   and `CODESPAR_PLUGINS=/example/demo-plugin.mjs`. This is the default
   path; no env vars required.

If none is available, the script prints setup instructions and exits
non-zero.

```bash
# Option A (recommended) — install Docker, then just run:
npm run validate

# Option B — point at a running runtime (you manage its lifecycle AND its
# ANTHROPIC_BASE_URL / CODESPAR_TEST_MODE_ENABLED / CODESPAR_PLUGINS):
export CODESPAR_BASE_URL=http://localhost:3000
npm run validate

# Option C — point at a local clone of codespar/codespar (the script
# manages it, in test mode, with the plugin loaded):
git clone https://github.com/codespar/codespar.git /tmp/codespar
(cd /tmp/codespar && git checkout main && npm install && npx turbo run build)
export CODESPAR_RUNTIME_DIR=/tmp/codespar
npm run validate
```

### Image channel — use `:main` until the next runtime release

The meta-tool mock seam and the `CODESPAR_PLUGINS` startup loader reach
the `:latest` image only on a runtime release tag. Until that release
lands, point the Docker mode at the bleeding-edge tag built on every main
merge:

```bash
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:main
npm run validate
```

## How the mocking layers compose

Two independently swappable layers sit between "fully offline test" and
"live production." Neither the test nor the runtime branches on demo
mode — each layer toggles by changing one configuration surface.

**Layer 1 — tool responses (session `mocks`).** The shared scenario
declares a fixture per meta-tool, posted on session create. With the
runtime in test mode (`CODESPAR_TEST_MODE_ENABLED=true`), a meta-tool
call is answered by its mock before the plugin's `execute()` runs; a call
with no matching entry fails with `tool_not_mocked` rather than reaching a
real provider. `codespar_invoice` is a stateful array, so the two calls
return distinct ids `nfse_demo_001` / `nfse_demo_002`.

**Layer 2 — LLM responses (`ANTHROPIC_BASE_URL` → aimock).**
`@copilotkit/aimock` serves the Anthropic Messages API shape on port
4010. The runtime's Anthropic SDK defaults `baseURL` to
`ANTHROPIC_BASE_URL`, so pointing it at aimock means every `session.send()`
lands on a scripted fixture instead of a real model. The fixture encodes
the three-turn dance: two `codespar_invoice` tool_uses → one
`codespar_notify` tool_use → final text.

## WhatsApp inbound: where this fits in production

The test calls `session.send(message)` directly. In production the same
call is invoked by the WhatsApp-inbound webhook bridge after the runtime
receives a message from the channel and resolves which session it belongs
to. The agent reasoning is identical either way — `session.send()` is the
single entry point the tool-use loop runs inside, whether the message
arrives via direct API call, webhook, or any other channel.

## Known gaps

Flagged here so they survive as latent debt rather than getting lost in
review comments:

1. **This demo does not exercise the live meta-tool routing.** The
   session mocks intercept at the meta-tool boundary, so the path that
   actually issues an NFS-e (`execute()` → Nuvem Fiscal) and sends the
   WhatsApp message (`execute()` → Z-API) never runs. That path is
   per-runtime by design; covering it end-to-end is a separate live test
   against provider sandboxes, not part of this deterministic proof.
2. **aimock fixtures are positional, not semantic.** They match on
   `turnIndex` and `hasToolResult`, not on the actual message content or
   tool-use shape. A runtime regression that changed tool-result ordering
   could still pass as long as the turn count holds.
3. **The aimock layer is a stand-in, not a model.** This example does not
   exercise real Claude reasoning. A regression in Anthropic's tool-use
   protocol (block ordering, stop_reason semantics) surfaces only in a
   live-model test gated on a real `ANTHROPIC_API_KEY`. Mocked tests catch
   wiring bugs; live tests catch protocol bugs.
4. **No streaming variant.** This example exercises only the unary
   `session.send()` shape, not `session.sendStream()` (SSE). A streaming
   variant would prove the SSE wire shape end-to-end and is a natural
   follow-up.
