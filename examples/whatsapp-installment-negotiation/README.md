# WhatsApp installment negotiation

A furniture retailer's agent receives a WhatsApp message from a buyer:

> *"Oi! Quero o sofa de R$4.800 que vi no site. Qual a melhor forma
> de pagar?"*

Three buyer turns later, the agent has:

1. Quoted two opening payment options out of its own reasoning — Pix
   with an 8% à-vista discount (R$4.416) versus 12x credit-card
   installments at R$400/month.
2. Computed a non-enumerated variant — "what about 6x?" — by calling
   the Asaas installment MCP in preview mode and presenting R$800/
   month back to the buyer.
3. Closed the sale by creating the installment payment via
   [`@codespar/mcp-asaas`](https://www.npmjs.com/package/@codespar/mcp-asaas),
   issuing the NF-e via
   [`@codespar/mcp-nuvem-fiscal`](https://www.npmjs.com/package/@codespar/mcp-nuvem-fiscal),
   and sending the confirmation back via
   [`@codespar/mcp-z-api`](https://www.npmjs.com/package/@codespar/mcp-z-api).

This example exercises **multi-turn `session.send()`** with inline MCP
calls — three buyer messages, five LLM completion turns (each round of
tool execution yields one extra completion request), three distinct
MCP servers. The walking skeleton at
[`../pix-nfse-skeleton/`](../pix-nfse-skeleton/) wires the OSS bridge
with a deterministic `loop()`; the natural-language demo at
[`../nfse-from-natural-language/`](../nfse-from-natural-language/)
adds a single-turn LLM step on top; this example layers multi-turn
state on top of that and runs the whole thing offline with
[`@copilotkit/aimock`](https://www.npmjs.com/package/@copilotkit/aimock)
in place of Anthropic so no real keys are needed.

## Why this requires an agent (the BSP contrast)

The sharpest single-sentence differentiator in the codespar demo
series: **a BSP flow-builder (Blip, Zenvia, Take) breaks definitively
when the buyer asks for a payment option the merchant didn't
pre-author.** "What about 6x?" was not on the menu. The flow-builder
has no branch for it. The agent computes the variant in real time by
calling the payment MCP with the requested term, presents the result,
and closes — none of which is determinable at authoring time.

The judgment points compound across the conversation:

- **Which options to present first.** The agent picks Pix with
  discount vs. 12x as opening offers because both maximise either
  cash conversion (Pix) or accessible price-points (12x). Picking
  the wrong opener costs deals — there's no rule that fires here.
- **How to answer a non-enumerated variant.** "What about 6x?" can
  only be answered by computing it. The agent calls Asaas, gets
  R$800/month back, presents it. A script that anticipated only
  pre-enumerated installment counts misroutes silently on every
  other request.
- **When to stop exploring and close.** After the buyer says
  "confirma, pode fechar" the agent does NOT propose another
  variant; it commits the payment and issues the NF-e. Knowing when
  to stop is a judgment call a script cannot make.

That's the agent thesis in one paragraph for B2C commerce. The
walking skeleton proves the infrastructure runs end-to-end; this
example proves the runtime carries an agent through a multi-turn
commerce conversation a flow-builder cannot.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Vitest spec — calls `session.send()` three times across the buyer's turns, asserts the Asaas preview, the Asaas `create_payment` with `installments: 6`, the Nuvem Fiscal `create_nfe`, and at least one Z-API `send_text` carrying the confirmation |
| `live.test.ts` | Live LLM smoke — gated on `CODESPAR_LIVE_SMOKE=1`, runs the same three-turn flow against real `api.anthropic.com` with coarser, probabilistic-tolerant assertions |
| `package.json` | Pins `@codespar/mcp-asaas@0.2.0`, `@codespar/mcp-nuvem-fiscal@0.3.0`, `@codespar/mcp-z-api@0.2.1` (exact pins), `@codespar/sdk@^0.9.0`, and `@copilotkit/aimock@^1.24.1` |
| `mcp-servers.json` | Server registry consumed by the bridge — three stdio servers (`asaas`, `nuvem-fiscal`, `z-api`), spawned plain so the runtime registers their tool schemas; tool responses come from the test's inline `mocks` map, not the servers |
| `fixtures/aimock-fixtures.json` | Five-entry aimock fixture: opener text → Asaas preview tool_use → preview reply text → close tool_use × 3 → confirmation text |
| `scripts/validate.sh` | Boots aimock first, then resolves a runtime (already-running / local clone / docker) with `CODESPAR_TEST_MODE_ENABLED=true`, polls `/health`, runs vitest, kills both on exit |
| `scripts/validate-live.sh` | Same three runtime modes, no aimock, requires real `ANTHROPIC_API_KEY` — runs `live.test.ts` only |
| `tsconfig.json` | Minimal TS config (NodeNext, strict, vitest globals) |
| `vitest.config.ts` | Test timeouts long enough for multi-turn LLM-driven loops |
| `.gitignore` | `node_modules/`, runtime + aimock log/pid files |

## Two run paths

```bash
cd examples/whatsapp-installment-negotiation
npm install
npm run validate
```

`validate.sh` always boots aimock on port 4010 first (the LLM
stand-in), then picks one of three runtime sources, first match wins:

1. **`CODESPAR_BASE_URL` is set** — uses the already-running runtime
   at that URL. The script does NOT manage the runtime's lifecycle,
   and that runtime must already be configured with
   `ANTHROPIC_BASE_URL=http://localhost:4010` (or its `session.send()`
   call will hit the real Anthropic API instead of the local aimock)
   AND `CODESPAR_TEST_MODE_ENABLED=true` (or `cs.create()` rejects the
   test's `mocks` map with HTTP 501 `mocks_not_permitted`).
2. **`CODESPAR_RUNTIME_DIR` is set** — boots `node server/start.mjs`
   from that directory on port 3000 with
   `ANTHROPIC_BASE_URL=http://localhost:4010`,
   `ANTHROPIC_API_KEY=placeholder`, and `CODESPAR_TEST_MODE_ENABLED=true`
   exported, polls `/health` for up to 20s, runs vitest, then kills
   the runtime + aimock on exit. The clone must include the runtime's
   session-mocks support (commit `5830dc4` / PR #113 or later on `main`).
3. **`docker` is on PATH** — pulls and runs
   `ghcr.io/codespar/codespar:latest` with the example dir mounted at
   `/example`, `--add-host=host.docker.internal:host-gateway` so the
   container can reach the host's aimock at `host.docker.internal:4010`,
   and `CODESPAR_TEST_MODE_ENABLED=true` wired in. This is the default
   path; no env vars required. The image must include session-mocks
   support (commit `5830dc4` / PR #113 or later).

If none is available, the script prints setup instructions and exits
non-zero.

```bash
# Option A (recommended) — install Docker, then just run:
npm run validate

# Option B — point at a running runtime (you manage its lifecycle AND
# make sure its ANTHROPIC_BASE_URL points at the local aimock AND it
# was started with CODESPAR_TEST_MODE_ENABLED=true).
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

# Move aimock off port 4010 if it conflicts with something else on
# your machine:
export AIMOCK_PORT=4020
npm run validate
```

> `:latest` is republished on each `v*` tag of `codespar/codespar`; the structural fix to also publish from `main` on every push is tracked in [codespar/codespar#117](https://github.com/codespar/codespar/issues/117).

## Three mockability layers

The example pins three independently swappable layers between "fully
offline test" and "live production." Each one toggles by changing a
single configuration surface; nothing in the test or runtime code
branches on demo mode.

**Layer 1 — tool responses (`mocks` on `cs.create()`).**
The runtime runs with `CODESPAR_TEST_MODE_ENABLED=true`, and the test
declares a per-tool `mocks` map on `cs.create({ servers, mocks })`.
Each key is a canonical `server/tool` name
(`asaas/get_installments`, `asaas/create_payment`,
`nuvem-fiscal/create_nfe`, `z-api/send_text`) and each value is the
deterministic payload that tool returns. In test mode the runtime
intercepts every external tool dispatch before it reaches the MCP
bridge — the servers still spawn (so their tool schemas register) but
never touch real Asaas, Nuvem Fiscal, or Z-API APIs, and any tool the
agent calls without a matching entry is a hard `tool_not_mocked`
failure rather than a silent fallthrough. Fixtures are pinned
per-test, so each test owns the exact shape it asserts on instead of
trusting an MCP server's demo handler. To swap to live: unset
`CODESPAR_TEST_MODE_ENABLED` and export real `ASAAS_API_KEY`,
`NUVEM_FISCAL_CLIENT_ID` / `_CLIENT_SECRET`, and `Z_API_*`
credentials.

**Layer 2 — LLM responses (`ANTHROPIC_BASE_URL` → aimock).**
`@copilotkit/aimock` listens on port 4010 and serves the Anthropic
Messages API shape. The runtime's Anthropic SDK honours
`ANTHROPIC_BASE_URL`, so pointing it at aimock means every
`session.send()` call lands on a pre-scripted fixture instead of a
real model. The fixture file at `fixtures/aimock-fixtures.json`
encodes the five-turn dance: opener text → preview tool_use → preview
reply text → close tool_uses × 3 → final confirmation text. To swap
to live: unset `ANTHROPIC_BASE_URL` and set a real
`ANTHROPIC_API_KEY` (see "Live LLM smoke" below).

**Layer 3 — live everything.** Unset `CODESPAR_TEST_MODE_ENABLED` so
the runtime dispatches tools for real, set real Asaas + Nuvem Fiscal +
Z-API credentials, unset `ANTHROPIC_BASE_URL`, and the same test code
runs against real fiscal-authority endpoints, real WhatsApp delivery,
real PSP charges, and a real Claude model. The test code does not
change. The `mocks` map and the aimock fixture both become dead
weight, which is the point: fixtures are the on-ramp, not the
destination.

### How to extend the fixture for your own multi-turn flow

The five-entry fixture maps onto three buyer messages because each
round of tool execution generates one extra LLM completion request.
`turnIndex` counts assistant messages within a single `session.send()`
call — it resets to 0 on every new send, since each send starts a
fresh chat loop with just the new user message in the request:

| Aimock entry | Triggered by | Match key | Response |
|---|---|---|---|
| 0 | buyer message 1 (`session.send`) | `turnIndex: 0, hasToolResult: false, userMessage~"sof"` | text only |
| 1 | buyer message 2 (`session.send`) | `turnIndex: 0, hasToolResult: false, userMessage~"6x"` | tool_use |
| 2 | tool result returns (same send as #1) | `turnIndex: 1, hasToolResult: true, userMessage~"6x"` | text only |
| 3 | buyer message 3 (`session.send`) | `turnIndex: 0, hasToolResult: false, userMessage~"Confirma"` | three parallel tool_uses |
| 4 | tool results return (same send as #3) | `turnIndex: 1, hasToolResult: true, userMessage~"Confirma"` | text only |

To copy the pattern to your own demo: count one fixture entry per
LLM completion the runtime will make, not per buyer message. Within
a single `session.send()`, `turnIndex` increments on every completion
request — including the "after tool result" continuations — so
`turnIndex` + `hasToolResult` together uniquely identify each entry
within that send. Across sends, `turnIndex` restarts at 0, so use
`userMessage~"keyword"` as the discriminator that anchors which
buyer message a given LLM turn corresponds to (it's also what keeps
the `hasToolResult: true` continuations from colliding across sends).
Note that `userMessage` matching is a case-sensitive substring check,
so use the exact casing the buyer types (e.g. `"Confirma"`, not
`"confirm"`).

**Demo arithmetic is flat (no juros).** The `asaas/get_installments`
mock returns a flat `installmentValue = value / installments`
(R$4.800 / 6 = R$800) with no interest, to keep the demo
deterministic and the fixture coupling simple. Real
Brazilian credit-card installments usually carry interest after 3x or
6x; modelling that would shift the NF-e taxable amount in ways that
deserve their own demo (tracked as a known gap in the section below).

## WhatsApp inbound: where this fits in production

The test calls `session.send(buyerMessage)` three times directly. In
production, each `session.send()` call is invoked by the
WhatsApp-inbound webhook bridge after the runtime receives a message
from Z-API and resolves which session it belongs to. The agent
reasoning is identical in both cases — `session.send()` is the single
entry point the LLM tool-use loop runs inside, whether the message
arrives via direct API call, webhook, or any other channel. This
example exercises the loop from the test runner across three turns;
swap the entry point and the rest is unchanged.

In the current OSS runtime, each `session.send()` call is a fresh
chat loop scoped to that single message — the runtime does not yet
carry conversation history across sends, so each turn's LLM call
sees only the new buyer message plus the tool-result continuation
within the same send. The aimock fixture mirrors that: `turnIndex`
restarts at 0 on every send, and `userMessage~"keyword"` anchors
which buyer message a fixture belongs to. The narrative continuity
you see in the demo lives in the fixture authoring (turn-2 text
references "6x", turn-3 tool-calls reference the previously
discussed payment), not in shared message state inside the runtime.
Cross-send history is on the roadmap; demos that depend on it can
plug in once it lands without changing this test's shape.

## Acceptance criteria

The vitest spec asserts these invariants across the three
`session.send()` calls:

1. **Turn 1** — the response carries a string `message` field with no
   `tool_calls` (the opener is conversation only).
2. **Turn 2** — at least one `asaas__get_installments` call with
   `input.value === 4800` and `input.installments === 6`, output
   carrying `preview: true`, `installmentCount: 6`, and
   `installmentValue: 800` across a six-entry `installments` array
   whose items each report `status: "PREVIEW"`.
3. **Turn 3** — exactly one `asaas__create_payment` call with
   `input.billingType === "CREDIT_CARD"`, `input.value === 4800`,
   `input.installments === 6`, output carrying `id` matching
   `/^pay_demo_/`, `installments: 6`, `installmentValue: 800`.
4. **Turn 3** — exactly one `nuvem-fiscal__create_nfe` call with
   output carrying `id` matching `/^nfe_demo_/` and
   `status === "autorizada"`.
5. **Turn 3** — at least one `z-api__send_text` call whose
   `input.message` matches `/confirm/i`.
6. **Cross-turn** — the total `iterations` across the three calls is
   at least 3 (the chat loop iterated multiple times within the
   tool-using turns).
7. **Cross-turn** — every dispatched tool call across every turn
   records `status === "success"` (no swallowed failures).

## Live LLM smoke (`npm run validate:live`)

`validate.sh` is fully mocked — aimock stands in for Anthropic, and
tool responses come from the `mocks` API on `cs.create()` (runtime in
test mode). That gets the example green deterministically and cheaply,
but it cannot catch regressions that only surface against real
`api.anthropic.com`: tool-name regex violations, invalid model ids,
system-prompt issues that change Claude's behaviour across turns. To
verify those too, run:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run validate:live
```

That boots a runtime with your `ANTHROPIC_API_KEY` (no aimock), runs
`live.test.ts`, and tears down. The live path points the runtime at a
separate `mcp-servers.live.json` (via `CODESPAR_MCP_SERVERS_PATH`)
that re-injects the MCP `--demo` flag, so no Asaas / Nuvem-Fiscal /
Z-API credentials are needed; the test-mode path uses the default
`mcp-servers.json` and stubs at the runtime layer via
`cs.create({ mocks })`. Two paths, two configs, one cleanly-split
dependency surface. The live test carries much more explicit per-turn
prompts than the aimock
test — buyer role, product, amount, demo-mode framing, and
turn-specific instructions — because real Claude is appropriately
cautious on under-specified commerce prompts and will ask for
clarifying details unless the intent is made explicit. The aimock
fixture gets away with terser prompts because it is scripted, not
reasoned. The assertions stay coarse (at-least-one Asaas preview
call, at-least-one `create_payment`, at-least-one NF-e, all
dispatched tools succeed) because real Claude is probabilistic.

This is **not in CI** — it costs real Anthropic spend (a few cents
per run) and is probabilistic enough that flakes would be noise. Run
it locally before pushing changes that touch the OSS chat loop, the
tool catalog, the SDK's `session.send()`, the LATAM-commerce system
prompt, or this example's MCP fixtures. The aimock-mode tests cannot
catch tool-name regex violations or invalid model ids; only this can.

## Known platform gaps

Flagged here so they survive as latent debt rather than getting lost
in review comments:

1. **Installment interest is not modelled in the NF-e taxable
   amount.** Brazilian credit-card installments often carry
   `juros parcelado` (interest on the financed total) that increases
   the taxable amount on the NF-e. The Asaas demo handler in this
   example computes `value / installments` flat with no interest, and
   the NF-e is issued for the original sticker price. In production,
   if interest is added the NF-e taxable amount changes — and that
   recalculation is genuinely fiddly because each PSP exposes
   interest differently and the SEFAZ rules vary by state. Tracked
   as a follow-on issue; not in scope for this demo.
2. **Fixture coupling — resolved by the mocks API.** `aimock@1.24.1`
   matches LLM fixtures on structure (`turnIndex`, `hasToolResult`,
   `userMessage` substring), not on the actual tool-result values from
   a prior turn, so turn 2's "R$800,00 por mes" reply text is
   hardcoded in the aimock fixture and has to agree with whatever the
   tool layer returns for `installmentValue`. Previously that agreement
   depended on trusting the MCP server's demo-handler math. The mocks
   API closes that gap: the tool output is pinned per-test directly on
   `cs.create({ mocks })` — `asaas/get_installments` returns
   `installmentValue: 800` because this test says so, not because a
   demo handler computed it — so the reply text and the tool value are
   authored side by side in one file and stay in sync by construction.
   The only residual coupling is keeping those two literals consistent
   when you edit the fixture, which a copying customer can see at a
   glance.
3. **The aimock layer is a stand-in, not a model.** This example
   does NOT exercise real Claude reasoning in the default test
   path. A regression in Anthropic tool-use protocol (block
   ordering, stop_reason semantics, multi-turn history-passing) will
   not surface in `skeleton.test.ts` — only in `live.test.ts`,
   which is gated on a real `ANTHROPIC_API_KEY`. Mocked tests catch
   wiring bugs; live tests catch protocol bugs.
4. **No streaming variant.** The runtime also exposes
   `session.sendStream()` (Server-Sent Events for incremental
   assistant_text / tool_use / tool_result events). This example
   exercises only the unary `session.send()` shape across three
   calls. A streaming variant would prove the SSE wire shape end-to-
   end for multi-turn flows and is a natural follow-up.
