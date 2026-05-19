# Service invoice from a natural-language message

A SaaS company's agent receives a WhatsApp message from a customer:

> *"Need invoice for the platform access fee plus the onboarding
> consulting — R$2.800 platform, R$1.200 consulting."*

One call to `session.send(message)` later, the agent has:

1. Picked the correct LC 116/2003 service code for each line item
   (Item 1.05 "informação e meios eletrônicos" for the SaaS access
   fee, Item 17.01 "assessoria ou consultoria" for the onboarding
   work), because the right ISS rate depends on which line each item
   sits on and a script cannot infer that from "platform access fee."
2. Issued two distinct NFS-e via
   [`@codespar/mcp-nuvem-fiscal`](https://www.npmjs.com/package/@codespar/mcp-nuvem-fiscal),
   one per service line.
3. Sent one WhatsApp message back via
   [`@codespar/mcp-z-api`](https://www.npmjs.com/package/@codespar/mcp-z-api)
   carrying both NFS-e PDF URLs.

This example is the **agent-thesis end-to-end**: a natural-language
prompt drives the tool-use loop inside `session.send()` against the
OSS MCP bridge. The walking skeleton at
[`../pix-nfse-skeleton/`](../pix-nfse-skeleton/) wires the same bridge
with a 4-step deterministic `loop()`; this example replaces the
deterministic loop with the runtime's Claude tool-use loop and uses
[`@copilotkit/aimock`](https://www.npmjs.com/package/@copilotkit/aimock)
in place of Anthropic so the whole test runs offline with no real
keys.

## Why this requires an agent

The sharpest single-sentence differentiator for B2B service
invoicing: **a customer's natural-language description of "platform
access plus onboarding consulting" cannot be mapped to LC 116/2003
service codes by any fixed (description → code) lookup, because the
right bracket depends on what the line item *means* in context, not
on which keywords appear.** A flow-builder that stamps a single
service code per request gets it wrong every time a customer
combines multiple service types in one message.

The judgment points compound inside this one short message:

- **Splitting the line items.** "Platform access fee plus onboarding
  consulting" is two services, not one — the agent has to recognise
  the conjunction and issue two distinct NFS-e. A line-counting
  heuristic over commas or "plus" tokens misroutes whenever the
  customer phrases two services in a single noun phrase.
- **Picking the right bracket per line.** LC 116/2003 enumerates
  service categories that map 1:1 to ISS-rate brackets — Item 1.01
  (software development), 1.03 (data processing), 1.05 (information
  and electronic-media services), 17.01 (advice / consulting). A
  SaaS access fee is 1.05; consulting on top of that SaaS is 17.01.
  São Paulo municipal ISS runs 2.9 % – 5 % depending on the bracket;
  stamping the wrong code is the tax-authority equivalent of
  charging the wrong currency.
- **Delivering the artefacts back on the same channel.** Once both
  NFS-e are issued, the agent has to send both PDF URLs back via
  WhatsApp — not just the first, not bundled into a "talk to
  support" link. Knowing the customer expects both invoices in the
  same reply is a judgment call a fixed flow cannot make.

That is the agent thesis in one paragraph for B2B service
invoicing. The walking skeleton proves the OSS bridge runs the
4-step happy path; this example proves the runtime carries an LLM
through a fiscal-taxonomy decision a flow-builder cannot.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Vitest spec — calls `session.send(naturalLanguagePrompt)`, asserts two `nuvem-fiscal__create_nfse` calls plus at least one `z-api__send_text` call whose message body carries both PDF URLs |
| `package.json` | Pins `@codespar/mcp-nuvem-fiscal@^0.3.0`, `@codespar/mcp-z-api@^0.2.1`, and `@copilotkit/aimock@^1.24.1` |
| `mcp-servers.json` | Server registry consumed by the bridge — same shape as the walking skeleton, two stdio servers, both spawned with `--demo` |
| `fixtures/aimock-fixtures.json` | Three-turn aimock fixture: turn 0 emits two `nuvem-fiscal__create_nfse` tool_use blocks; turn 1 emits one `z-api__send_text` tool_use; turn 2 emits the final text summary |
| `scripts/validate.sh` | Boots aimock first, then resolves a runtime (Docker / local clone / already-running), polls `/health`, runs vitest, kills both on exit |
| `tsconfig.json` | Minimal TS config (NodeNext, strict, vitest globals) |
| `vitest.config.ts` | 60s test timeout (LLM-driven loops are slower than the deterministic skeleton) |
| `.gitignore` | `node_modules/`, runtime + aimock log/pid files |

## Three run paths

```bash
cd examples/nfse-from-natural-language
npm install
npm run validate
```

`validate.sh` always boots aimock on port 4010 first (the LLM
stand-in), then picks one of three runtime sources, first match wins:

1. **`CODESPAR_BASE_URL` is set** — uses the already-running runtime
   at that URL. The script does NOT manage the runtime's lifecycle,
   and that runtime must already be configured with
   `ANTHROPIC_BASE_URL=http://localhost:4010` or its `session.send()`
   call will hit the real Anthropic API instead of the local aimock.
2. **`CODESPAR_RUNTIME_DIR` is set** — boots `node server/start.mjs`
   from that directory on port 3000 with
   `ANTHROPIC_BASE_URL=http://localhost:4010` and
   `ANTHROPIC_API_KEY=placeholder` exported, polls `/health` for up to
   20s, runs vitest, then kills the runtime + aimock on exit.
3. **`docker` is on PATH** — pulls and runs
   `ghcr.io/codespar/codespar:latest` with the example dir mounted at
   `/example` and `--add-host=host.docker.internal:host-gateway` so
   the container can reach the host's aimock at
   `host.docker.internal:4010`. This is the default path; no env vars
   required.

If none of the above is available, the script prints setup
instructions and exits non-zero.

```bash
# Option A (recommended) — install Docker, then just run:
npm run validate

# Option B — point at a running runtime (you manage its lifecycle AND
# make sure its ANTHROPIC_BASE_URL points at the local aimock).
export CODESPAR_BASE_URL=http://localhost:3000
npm run validate

# Option C — point at a local clone of codespar/codespar.
git clone https://github.com/codespar/codespar.git /tmp/codespar
(cd /tmp/codespar && npm install && npx turbo run build)
export CODESPAR_RUNTIME_DIR=/tmp/codespar
npm run validate

# Pin a specific runtime image instead of :latest:
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:v0.1.0
npm run validate

# Move aimock off port 4010 if it conflicts with something else on
# your machine:
export AIMOCK_PORT=4020
npm run validate
```

## Three mockability layers

The example pins three independently swappable layers between "fully
offline test" and "live production." Each one toggles by changing a
single configuration surface; nothing in the test or runtime code
branches on demo mode.

**Layer 1 — MCP server fixtures (`--demo` in `mcp-servers.json`).**
The two MCP servers spawn with their `--demo` flag, which makes them
return deterministic fixture payloads without touching real Nuvem
Fiscal or Z-API APIs. `@codespar/mcp-nuvem-fiscal@^0.3.0` has a
stateful demo handler — two `create_nfse` calls inside one process
return distinct ids `nfse_demo_001` / `nfse_demo_002` and echo the
input `servico.codigo`, `valor`, and `servico.descricao` back. To
swap to live: drop `--demo` from `mcp-servers.json` and export the
real `NUVEM_FISCAL_CLIENT_ID` / `NUVEM_FISCAL_CLIENT_SECRET` (OAuth
client credentials) plus a `Z_API_*` instance + token.

**Layer 2 — LLM responses (`ANTHROPIC_BASE_URL` → aimock).**
`@copilotkit/aimock` listens on port 4010 and serves the Anthropic
Messages API shape. The runtime's Anthropic SDK honours
`ANTHROPIC_BASE_URL`, so pointing it at aimock means every
`session.send()` call lands on a pre-scripted fixture instead of a
real model. The fixture file at `fixtures/aimock-fixtures.json` encodes the
three-turn dance: tool_use × 2 → tool_use × 1 → final text. To swap to
live: unset `ANTHROPIC_BASE_URL` and set a real `ANTHROPIC_API_KEY`.

**Layer 3 — live everything.** Remove `--demo` from
`mcp-servers.json`, set real Nuvem Fiscal + Z-API credentials, unset
`ANTHROPIC_BASE_URL`, and the same test code runs against real
fiscal-authority endpoints, real WhatsApp delivery, and a real Claude
model. The test code does not change. The fixture file becomes dead
weight, which is the point: fixtures are the on-ramp, not the
destination.

## WhatsApp inbound: where this fits in production

The test calls `session.send(naturalLanguageMessage)` directly. In
production, the same `session.send()` call is invoked by the
WhatsApp-inbound webhook bridge after the runtime receives a message
from Z-API and resolves which session it belongs to. The agent
reasoning is identical in both cases — `session.send()` is the single
entry point the LLM tool-use loop runs inside, whether the message
arrives via direct API call, webhook, or any other channel. This
example exercises the loop from the test runner; swap the entry point
and the rest is unchanged.

## Acceptance criteria

The vitest spec asserts these invariants inside the single
`session.send()` call:

1. **Two distinct `nuvem-fiscal__create_nfse` calls**, one per line
   item, both with `status === "success"`. The two calls must split on
   the LC 116/2003 service code — exactly one carries
   `input.servico.codigo === "1.05"` with `input.valor === 2800`, and
   exactly one carries `input.servico.codigo === "17.01"` with
   `input.valor === 1200`. A regression that flattens both line items
   to a single bracket trips here.
2. **Both NFS-e outputs carry demo-fixture shape.** Each call's
   `output.id` matches `/^nfse_demo_/`, `output.status === "autorizada"`,
   and `output.pdf_url` is a non-empty string.
3. **At least one `z-api__send_text` call** with `status === "success"`
   and `input.message` matching both `/nfse_demo_001/` and
   `/nfse_demo_002/` — proving the WhatsApp outbound references both
   PDFs, not just the first.
4. **`result.iterations >= 3`** — three completion requests inside one
   send (NFS-e tool-uses → z-api tool-use → final text), proving the
   tool loop actually iterated rather than collapsing into a single
   response.
5. **Every dispatched tool call records `status === "success"`** — no
   swallowed failures across the turn.

## Live LLM smoke (`npm run validate:live`)

`validate.sh` is fully mocked — aimock stands in for Anthropic, MCP servers stay in `--demo` mode. That gets the example green deterministically and cheaply, but it cannot catch regressions that only surface against real `api.anthropic.com`: tool-name regex violations, invalid model ids, system-prompt issues that change Claude's behaviour. To verify those too, run:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run validate:live
```

That boots a runtime with your `ANTHROPIC_API_KEY` (no aimock), runs `live.test.ts`, and tears down. The MCP servers stay in `--demo` so no Nuvem-Fiscal / Z-API credentials are needed. The live test carries a much richer prompt than the aimock test — it includes prestador/tomador hints, LC 116 codes, environment, and an explicit "don't ask for clarifying details" instruction — because real Claude is appropriately cautious on under-specified fiscal prompts and will ask for missing fields rather than issuing documents blindly. The aimock fixture gets away with a terser prompt because it's scripted, not reasoned. The assertions stay coarse (at-least-one NFS-e issuance dispatched, every dispatched call succeeds) because real Claude is probabilistic.

This is **not in CI** — it costs real Anthropic spend (a few cents per run) and is probabilistic enough that flakes would be noise. Run it locally before pushing changes that touch the OSS chat loop, the tool catalog, the SDK's `session.send()`, the LATAM-commerce system prompt, or this example's MCP fixtures. The aimock-mode tests can't catch tool-name regex violations or invalid model ids; only this can.

## Known platform gaps

Flagged here so they survive as latent debt rather than getting lost
in review comments:

1. **Fixture coverage of fiscal edge cases is shallow.** The
   `create_nfse` demo handler models the happy path: stateful id
   generation, echoed inputs, `status: "autorizada"`. It does not
   model SEFAZ amendment windows (NFS-e issued within 24h can usually
   be amended, beyond that you cut a cancellation NFS-e), the
   municipal ISS-rate differentials that determine which prefecture
   to file under for cross-municipality work, contested-cart fiscal
   blocks (when payment dispute opens, the NFS-e must be withheld or
   reversed), or LGPD / PCI considerations for the customer-data
   payload. These all matter in production and are not exercised by
   this example.
2. **aimock fixture is positional, not semantic.** The fixture
   matches on `turnIndex` and `hasToolResult`, not on the actual
   content of the user's message or the runtime's tool-use shape. A
   regression in the runtime that, say, started sending the tool
   results in a different order would still pass this fixture as long
   as the turn count is right. A more rigorous fixture would gate on
   the model + tools[] schema as well.
3. **The aimock layer is a stand-in, not a model.** This example
   does NOT exercise real Claude reasoning. A regression in Anthropic
   tool-use protocol (block ordering, stop_reason semantics) won't
   surface here — only in a separate live-model test that is gated
   on a real `ANTHROPIC_API_KEY`. Mocked tests catch wiring bugs;
   live tests catch protocol bugs.
4. **No streaming variant.** The runtime also exposes
   `session.sendStream()` (Server-Sent Events for incremental
   assistant_text / tool_use / tool_result events). This example
   exercises only the unary `session.send()` shape. A streaming
   variant would prove the SSE wire shape end-to-end and is a natural
   follow-up.
