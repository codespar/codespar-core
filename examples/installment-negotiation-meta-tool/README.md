# Installment negotiation at the meta-tool abstraction

A buyer negotiates how to pay for a R$4.800 sofa over three WhatsApp turns:

> *"Quero o sofá de R$4.800. Qual a melhor forma de pagar?"*
> *"Em 6x dá pra fechar?"*
> *"Confirma, pode fechar."*

The agent presents payment options, computes the 6x term, and closes the sale.
On the final turn it calls three commerce **meta-tools** — `codespar_pay`
(create the installment payment), `codespar_invoice` (issue the NF-e), and
`codespar_notify` (confirm over WhatsApp) — never a raw `serverId__tool`.

This is the **multi-turn** dual-runtime demo: unlike the single-shot
service-invoice demo, it exercises a three-message `session.send()` negotiation
where only the commit touches commerce.

## Why the negotiation is text, not tool calls

At the meta-tool abstraction there is no quote/preview tool, and `codespar_pay`
*executes* a payment — it doesn't price one. So the agent reasons about the
no-interest installment math itself (R$4.800 / 6 = R$800) and answers in text;
only the buyer's confirmation triggers a meta-tool call. That is the cleaner
meta-tool shape — and the same on both runtimes. The raw-tool original called a
PSP preview tool (`asaas/get_installments`) for the same step; the meta-tool
version pushes that into the agent's reasoning (for the simple no-interest case)
or into `codespar_pay`'s implementation (for interest-bearing plans).

## One scenario, both runtimes

The scenario and its assertion live in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), not
here:

```ts
import { runDemoScenario, INSTALLMENT_NEGOTIATION_SCENARIO } from "@codespar/types/testing";

runDemoScenario(CODESPAR_BASE_URL, INSTALLMENT_NEGOTIATION_SCENARIO, { apiKey });
```

The **same** `INSTALLMENT_NEGOTIATION_SCENARIO` object and aimock fixture set are
consumed unchanged by the managed-runtime integration test.
`runDemoScenario` drives the three turns and asserts, via
`assertMetaToolTrace`, that every tool the agent called was a meta-tool
(`codespar_*`) with `status: "success"`, and that no raw `serverId__tool` name
appears.

## OSS core ships no built-in meta-tools — the demo opts in

The managed runtime ships the commerce meta-tools pre-installed; OSS core does
not. `demo-plugin.mjs` registers `codespar_invoice`, `codespar_notify`, and
`codespar_pay` through the `MetaToolHook` seam (using the shared `@codespar/types`
definitions), and the runtime loads it at startup via `CODESPAR_PLUGINS`. In test
mode the session `mocks` (keyed on the meta-tool name) answer the call before the
plugin's `execute()` runs, so `execute()` here is a deliberate tripwire — a real
deployment would implement it to route the meta-tool to its providers.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Imports `runDemoScenario` + `INSTALLMENT_NEGOTIATION_SCENARIO` from `@codespar/types/testing` and runs them against `CODESPAR_BASE_URL` |
| `demo-plugin.mjs` | Registers `codespar_invoice` + `codespar_notify` + `codespar_pay` as meta-tools via the `MetaToolHook` seam |
| `fixtures/aimock-fixtures.json` | Four-fixture aimock set: turns 1-2 are text-only; turn 3 emits the three tool_use blocks, then a final summary |
| `scripts/validate.sh` | Boots aimock + a runtime (already-running / local clone / docker) with test mode + the plugin loaded, runs vitest |
| `package.json` | Pins `@codespar/types@^0.10.11` (scenario + definitions) and `@copilotkit/aimock` |
| `tsconfig.json` / `vitest.config.ts` / `.gitignore` | Standard example config |

There is no `mcp-servers.json` — that's the raw-tool bridge spawn recipe, and a
meta-tool agent never touches it.

## Run

```bash
cd examples/installment-negotiation-meta-tool
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
   intercept at the meta-tool boundary, so the path that actually creates the
   payment (`execute()` → Asaas) and issues the NF-e never runs. That path is
   per-runtime by design; covering it end-to-end is a separate live test.
2. **aimock fixtures are positional, not semantic** — they match on `turnIndex`
   and `hasToolResult`, not message content or tool-use shape.
3. **No streaming variant** — only the unary `session.send()` shape is exercised.
