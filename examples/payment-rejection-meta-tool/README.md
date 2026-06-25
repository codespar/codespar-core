# Payment rejection / cross-provider retry at the meta-tool abstraction

A Pix payment is declined because the customer's Pix key is invalid. The agent
asks for a corrected key over WhatsApp, retries, and issues the NF-e:

> *"Quero pagar R$2.500 via Pix. Minha chave é cliente-demo@pix.invalid"*
> *"Opa, a chave correta é cliente.demo@banco.com"*

Across the two turns the agent calls `codespar_pay` twice (declined, then
retried), `codespar_notify` twice (ask, then confirm), and `codespar_invoice`
once — never a raw PSP tool.

## Why this dissolves the old "second PSP" blocker

At the raw-tool layer this demo needed two PSP servers (e.g. Asaas + PagBank)
with demo fixtures to show a fallback. At the meta-tool layer the agent never
calls two raw PSPs — it calls `codespar_pay`, which owns provider routing
internally. The reject-then-retry **judgment** lives in the agent (interpret
`INVALID_PIX_KEY` as a customer-data problem → ask for a correction, not blindly
retry another PSP), and the **routing** lives in the meta-tool. One meta-tool,
one stateful fixture sequence.

The first `codespar_pay` mock is a **successful dispatch whose business outcome
is a decline** (`status: "rejected"`, `error_code: "INVALID_PIX_KEY"`) — a
rejected payment is a successful API call that returns a declined result, so the
meta-tool call still reports `status: "success"` at the trace level. The agent
reads the declined output and drives the correction.

## The canonical scenario

The scenario and its assertion live in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), the
single source of truth this example consumes, not here:

```ts
import { runDemoScenario, PAYMENT_REJECTION_SCENARIO } from "@codespar/types/testing";

runDemoScenario(CODESPAR_BASE_URL, PAYMENT_REJECTION_SCENARIO, { apiKey });
```

`PAYMENT_REJECTION_SCENARIO` is the canonical scenario published in
`@codespar/types/testing`, paired with its aimock fixture set.
`runDemoScenario` drives the turns and asserts, via
`assertMetaToolTrace`, that every tool the agent called was a meta-tool
(`codespar_*`) with `status: "success"`, and that no raw `serverId__tool` name
appears. `codespar_pay`'s mock is a stateful array — the first call returns the
decline, the second returns success.

## The core ships no built-in meta-tools — the demo opts in

`@codespar/core` exposes the `MetaToolHook` seam but registers nothing by
default. `demo-plugin.mjs` registers `codespar_invoice`, `codespar_notify`, and
`codespar_pay` through that seam (using the shared `@codespar/types`
definitions), and the runtime loads it at startup via `CODESPAR_PLUGINS`. In test
mode the session `mocks` answer each call before the plugin's `execute()` runs,
so `execute()` here is a deliberate tripwire — a real deployment would implement
it to route the meta-tool to its providers.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Imports `runDemoScenario` + `PAYMENT_REJECTION_SCENARIO` from `@codespar/types/testing` and runs them against `CODESPAR_BASE_URL` |
| `demo-plugin.mjs` | Registers `codespar_invoice` + `codespar_notify` + `codespar_pay` as meta-tools via the `MetaToolHook` seam |
| `fixtures/aimock-fixtures.json` | Five-fixture aimock set: turn 1 declines then asks for a correction; turn 2 retries, issues the NF-e, and confirms |
| `scripts/validate.sh` | Boots aimock + a runtime (already-running / local clone / docker) with test mode + the plugin loaded, runs vitest |
| `package.json` | Pins `@codespar/types@^0.10.11` (scenario + definitions) and `@copilotkit/aimock` |
| `tsconfig.json` / `vitest.config.ts` / `.gitignore` | Standard example config |

There is no `mcp-servers.json` — that's the raw-tool bridge spawn recipe, and a
meta-tool agent never touches it.

## Run

```bash
cd examples/payment-rejection-meta-tool
npm install
npm run validate
```

`validate.sh` boots aimock on port 4010, then resolves a runtime (first match
wins): `CODESPAR_BASE_URL` (already-running) → `CODESPAR_RUNTIME_DIR` (local
clone) → `docker` (published image). Each path runs the runtime in test mode with
`CODESPAR_PLUGINS` pointed at this dir's `demo-plugin.mjs`.

### Image channel — use `:main` until the next runtime release

The meta-tool mock seam and the `CODESPAR_PLUGINS` startup loader reach the
`:latest` image only on a runtime release tag. Until then, point the Docker mode
at the bleeding-edge tag:

```bash
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:main
npm run validate
```

## Known gaps

1. **This demo does not exercise the live meta-tool routing.** The session mocks
   intercept at the meta-tool boundary, so the path that actually attempts the
   Pix charge (`execute()` → Asaas) never runs — including the real rejection.
   The reject-then-retry *judgment* is exercised; the real provider call is not.
   That path is per-runtime by design; covering it end-to-end is a separate live
   test.
2. **aimock fixtures are positional, not semantic** — they match on `turnIndex`
   and `hasToolResult`, not message content or tool-use shape.
3. **No streaming variant** — only the unary `session.send()` shape is exercised.
