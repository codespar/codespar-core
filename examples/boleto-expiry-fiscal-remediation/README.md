# Boleto-expiry fiscal remediation at the meta-tool abstraction

A customer messages: "I paid the boleto but didn't get my order." The most common
Brazilian post-purchase failure is exactly this — a boleto the customer believed
they paid, but it expired unpaid. The irreplaceable agent judgment is what comes
next: **discover the real payment state, communicate it without making the
customer feel accused, and make the fiscal-state call** — can the original NF-e be
corrected in place, or must it be cancelled and reissued? — before offering a
fresh Pix.

This example ships **two scenarios** that share one discovered state (a boleto
that is `OVERDUE`) but demand opposite fiscal remediations. A fixed flow gets one
of them wrong; only reading the NF-e's amendment-window state gets both right.

## The two branches

### Amendment window OPEN — correct the NF-e in place

```
codespar_payment_status  → { status: "OVERDUE", billing_type: "BOLETO" }
codespar_invoice[status] → { status: "autorizada", amendable: true }
codespar_invoice[amend]  → { mechanism: "correction_letter", cce_protocol: ... }
```

The SEFAZ correction window is still open, so the agent:

1. `codespar_payment_status` — discovers the boleto expired unpaid,
2. `codespar_notify`s the **customer** collaboratively (never accusing them),
3. `codespar_invoice` with `action: status` — reads the NF-e (still amendable),
4. `codespar_invoice` with `action: amend` — issues a correction letter (CC-e) **in place**,
5. `codespar_pay` — offers a fresh Pix for the same order.

The original NF-e is never cancelled.

### Amendment window CLOSED — cancel + reissue as a substitute

```
codespar_payment_status  → { status: "OVERDUE", billing_type: "BOLETO" }
codespar_invoice[status] → { status: "autorizada", amendable: false }
codespar_invoice[amend]  → { mechanism: "cancel_and_reissue",
                             substitute: { tipo: 3, status: "autorizada" } }
```

Same discovered boleto state, but the correction window has closed, so a CC-e is
no longer legal. The only correct remediation is to **cancel the original NF-e and
reissue it as a substitute** (`tipo: 3`, Substituto), then offer the fresh Pix.

### Why it needs an agent

A fixed "always correct in place" flow attempts a CC-e the SEFAZ window no longer
permits — an invalid fiscal action. A fixed "always cancel + reissue" flow throws
away a perfectly amendable document. Reading the amendment-window state and
choosing the legal mechanism (correction letter vs cancel + reissue) is the
irreplaceable fiscal judgment. Discovering the boleto state mid-conversation, and
breaking the news collaboratively rather than accusatorially, are the other two.

A status read is a **successful tool result whose payload carries business state**
(`status: "OVERDUE"`, an `amendable` flag), not a transport error — so the
meta-tool call still reports `status: "success"` at the trace level. The agent
reads the state and decides.

## This is live-graduatable — the live-backing map

Every meta-tool operation here maps to a real existing MCP tool. The demo runs
mocked (no credentials), but the contract is not mock-only by construction, and
the mocked result fields mirror the real provider responses:

| Meta-tool (operation) | Real backing MCP tool(s) | Note |
|---|---|---|
| `codespar_payment_status` | `asaas get_payment` | status enum includes `OVERDUE` = expired/unpaid boleto |
| `codespar_invoice` [status] | `nuvem_fiscal get_nfe` (+ `get_nfe_events`) | `autorizada` / `cancelada` / ... |
| `codespar_invoice` [amend] | `nuvem_fiscal send_correction_letter_nfe` (CC-e) OR `cancel_nfe` + `create_nfe` (tipo 3, Substituto) | which one is legal depends on what changed + the SEFAZ window |
| `codespar_pay` (new Pix) | `asaas create_payment` (PIX) + `get_pix_qrcode` | the fresh charge for the same order |
| `codespar_notify` | (existing) | the collaborative customer message |

The meta-tool to MCP routing layer that would run this live is not built yet (true
of every meta-tool today): the runtime executes a deterministic mock and this
example's plugin `execute()` is a live-path seam the demo never reaches. The demo
runs mocked now and graduates to live when the router lands.

## The new surface this demo introduces

- **`codespar_payment_status`** — query a payment/charge/boleto by id; returns the
  provider status. New shared definition.
- **`codespar_invoice` `action` discriminator** — `issue | status | amend`,
  defaulting to `issue` so existing issue-only callers are unaffected. `status`
  reads a document's fiscal state; `amend` corrects it (CC-e in place, or cancel +
  reissue), with the result indicating which mechanism applied.

## The canonical scenarios

The scenarios and their assertion live in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), the
single source of truth this example consumes, not here:

```ts
import {
  driveDemoScenario,
  assertMetaToolTrace,
  BOLETO_EXPIRED_NFE_CORRECTION_SCENARIO,
  BOLETO_EXPIRED_NFE_REISSUE_SCENARIO,
} from "@codespar/types/testing";
```

`assertMetaToolTrace` checks that every tool the agent called was a meta-tool
(`codespar_*`) with `status: "success"` and that no raw `serverId__tool` name
appears. On top of that, `skeleton.test.ts` pins the fiscal-state judgment itself:
the window-open case reads then amends (`action: status` then `action: amend`) and
never cancels; the window-closed case reads then cancels + reissues. Both cases
also assert the customer-facing message is **collaborative, not accusatory** — the
tactful-communication requirement made mechanical.

## Published scenarios, kept in sync

The two `DemoScenario` objects this example drives are published in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), not
defined here — so they can be reused, and so this example can prove it stays in
sync with them rather than forking a private copy.

A grouped `DEMO_SCENARIO_MANIFEST` (also published in `@codespar/types/testing`)
makes that mechanical: the manifest groups scenarios by example, and
`manifest-parity.test.ts` asserts this example drives exactly its own group
(**per-group completeness** — publish a new scenario into this group and forget to
add it here, and CI fails) and pins `@codespar/types` to the exact manifest version
(**version-alignment**). The example never drifts from the published scenario set,
and the manifest's grouping is what lets this demo coexist with the other
dual-runtime demos.

## The core ships no built-in meta-tools — the demo opts in

`@codespar/core` exposes the `MetaToolHook` seam but registers nothing by default.
`demo-plugin.mjs` registers `codespar_payment_status`, `codespar_invoice`,
`codespar_notify`, and `codespar_pay` through that seam (using the shared
`@codespar/types` definitions), and the runtime loads it at startup via
`CODESPAR_PLUGINS`. In test mode the session `mocks` answer each call before the
plugin's `execute()` runs, so no provider credentials are needed.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Drives both scenarios via `driveDemoScenario`, asserts the shared trace plus the fiscal-state judgment (amend-in-place vs cancel + reissue) and the collaborative-message content-quality check |
| `live.test.ts` | Optional real-Claude smoke (gated on `CODESPAR_LIVE_SMOKE`); mocked tools, no provider credentials |
| `manifest-parity.test.ts` | Keeps the example in sync with its published scenario group: per-group completeness + version-alignment against `DEMO_SCENARIO_MANIFEST` |
| `fixtures-sync.test.ts` | Guards the checked-in aimock fixtures against drift from the published scenarios |
| `demo-plugin.mjs` | Registers the four meta-tools via the `MetaToolHook` seam |
| `fixtures/aimock-fixtures.json` | The two scenarios' aimock fixtures, concatenated (disjoint match keys, one aimock serves both) |
| `scripts/validate.sh` | Boots aimock + a runtime (already-running / local clone / docker) in test mode with the plugin loaded, runs vitest |
| `scripts/validate-live.sh` | Boots a runtime against real Claude (test-mode mocks, no provider credentials) and runs `live.test.ts` |
| `package.json` | Pins `@codespar/types` (exact) and `@copilotkit/aimock` |

There is no `mcp-servers.json` — that's the raw-tool bridge spawn recipe, and a
meta-tool agent never touches it.

## Run

```bash
cd examples/boleto-expiry-fiscal-remediation
npm install
npm run validate
```

`validate.sh` boots aimock on port 4010, then resolves a runtime (first match
wins): `CODESPAR_BASE_URL` (already-running) → `CODESPAR_RUNTIME_DIR` (local
clone) → `docker` (published image). Each path runs the runtime in test mode with
`CODESPAR_PLUGINS` pointed at this dir's `demo-plugin.mjs`. No Anthropic key and no
provider credentials are needed.

### Image channel — use `:main` until the next runtime release

The meta-tool mock seam and the `CODESPAR_PLUGINS` startup loader reach the
`:latest` image only on a runtime release tag. Until then, point the Docker mode at
the bleeding-edge tag:

```bash
export CODESPAR_RUNTIME_IMAGE=ghcr.io/codespar/codespar:main
npm run validate
```

### Live smoke (optional, real Claude)

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run validate:live
```

Runs both scenarios against real `api.anthropic.com` with the tools still mocked
(no provider credentials). Costs a few cents; not wired into CI because it is
probabilistic.

## Known gaps

1. **Two branches ship, not the whole fiscal-correction space.** Exactly two
   amendment-window branches are demonstrated — open (correct in place via a CC-e)
   and closed (cancel + reissue as a substitute). Real post-purchase fiscal
   correction spans more cases (partial payments, multiple NF-e per order,
   interstate SEFAZ rule variation). This example proves the *judgment pattern*; a
   complete fiscal taxonomy is a documented, deliberate non-goal here.
2. **No rollback if the new Pix succeeds but the NF-e amend/reissue fails.** There
   is no declarative compensation path for that partial-failure case — the demo
   ships the happy path only. This is a known runtime limitation (the rollback-DSL
   gap tracked in the demo-series roadmap), exposed and documented here rather than
   solved.
3. **Provider routing is out of frame by design.** `codespar_pay` owns which PSP
   settles the fresh Pix; the agent never selects one. That is a platform concern
   below this altitude, not an agent judgment, so it is not demonstrated here.
4. **aimock fixtures are positional** — they match on `turnIndex` and
   `hasToolResult` (and a per-turn message substring), not full message content.
5. **No streaming variant** — only the unary `session.send()` shape is exercised.
