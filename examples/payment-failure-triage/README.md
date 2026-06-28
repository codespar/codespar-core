# Payment-failure triage at the meta-tool abstraction

When a payment is declined, the irreplaceable agent judgment is **reading the
failure's category and routing the remediation** — ask the customer to fix their
data, or escalate to a human and stop. The platform owns *provider* selection
inside `codespar_pay`; the agent never picks a PSP. What it picks is what to do
next, and that depends on *why* the payment failed.

This example ships **two scenarios** that share one surface (`codespar_pay`
returns a decline carrying a `category`) but demand opposite remediations. A
fixed flow gets one of them wrong; only reading the category gets both right.

## The two categories

### Customer-data failure — recoverable, ask the customer

```
codespar_pay  → { status: "rejected", category: "customer_data",
                  error_code: "INVALID_CPF_CNPJ" }
```

The customer's tax document (CPF/CNPJ) is invalid. This is recoverable by the
customer, so the agent:

1. `codespar_notify`s the **customer** asking for the correct document,
2. retries `codespar_pay` with the corrected data (now confirmed),
3. issues the NF-e via `codespar_invoice`.

No human escalation — the customer can fix the input themselves.

### Non-recoverable failure — escalate to a human, stop

```
codespar_pay  → { status: "rejected", category: "non_recoverable",
                  error_code: "MERCHANT_BLOCKED" }
```

The merchant's account is blocked by the acquirer. The customer cannot fix this,
so the agent `codespar_notify`s a **human** (an internal ops channel) and stops.
No retry, no invoice, and no message to the customer asking them to fix data that
was never the problem.

### Why it needs an agent

A fixed "ask the customer for corrected data and retry" flow handles the first
case but pesters the customer in the second, where the real fix is a human
unblocking the merchant. A fixed "escalate on any decline" flow handles the
second but gives up on a recoverable typo in the first. New rejection codes show
up in production regularly; only interpreting the *category* routes each one to
the right remediation.

A decline is a **successful tool result whose business outcome is a rejection**
(`status: "rejected"` with a `category`), not a transport error — so the
meta-tool call still reports `status: "success"` at the trace level. The agent
reads the declined output and decides.

## The canonical scenarios

The scenarios and their assertion live in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), the
single source of truth this example consumes, not here:

```ts
import {
  driveDemoScenario,
  assertMetaToolTrace,
  CUSTOMER_DATA_REJECTION_SCENARIO,
  MERCHANT_BLOCKED_SCENARIO,
} from "@codespar/types/testing";
```

`assertMetaToolTrace` checks that every tool the agent called was a meta-tool
(`codespar_*`) with `status: "success"` and that no raw `serverId__tool` name
appears. On top of that, `skeleton.test.ts` pins the triage judgment itself: the
customer-data case calls `codespar_pay` twice and `codespar_invoice` once and
never escalates to a human; the non-recoverable case calls `codespar_pay` once,
issues no invoice, sends no customer message, and escalates exactly once.

## Published scenarios, kept in sync

The two `DemoScenario` objects this example drives are published in
[`@codespar/types/testing`](https://www.npmjs.com/package/@codespar/types), not
defined here — so they can be reused, and so this example can prove it stays in
sync with them rather than forking a private copy.

A `DEMO_SCENARIO_MANIFEST` (also published in `@codespar/types/testing`) makes that
mechanical: `manifest-parity.test.ts` asserts this example drives exactly the
manifest's scenarios (**completeness** — publish a new scenario and forget to add
it here, and CI fails) and pins `@codespar/types` to the exact manifest version
(**version-alignment** — a caret/tilde or stale pin fails). The example never
drifts from the published scenario set.

## The core ships no built-in meta-tools — the demo opts in

`@codespar/core` exposes the `MetaToolHook` seam but registers nothing by
default. `demo-plugin.mjs` registers `codespar_invoice`, `codespar_notify`, and
`codespar_pay` through that seam (using the shared `@codespar/types`
definitions), and the runtime loads it at startup via `CODESPAR_PLUGINS`. In test
mode the session `mocks` answer each call before the plugin's `execute()` runs,
so no provider credentials are needed.

## What ships here

| File | Purpose |
|---|---|
| `skeleton.test.ts` | Drives both scenarios via `driveDemoScenario`, asserts the shared trace plus the triage judgment (escalation only when non-recoverable) |
| `live.test.ts` | Optional real-Claude smoke (gated on `CODESPAR_LIVE_SMOKE`); mocked tools, no provider credentials |
| `manifest-parity.test.ts` | Keeps the example in sync with the published scenarios: completeness + version-alignment against `DEMO_SCENARIO_MANIFEST` |
| `fixtures-sync.test.ts` | Guards the checked-in aimock fixtures against drift from the published scenarios |
| `demo-plugin.mjs` | Registers the three meta-tools via the `MetaToolHook` seam |
| `fixtures/aimock-fixtures.json` | The two scenarios' aimock fixtures, concatenated (disjoint match keys, one aimock serves both) |
| `scripts/validate.sh` | Boots aimock + a runtime (already-running / local clone / docker) in test mode with the plugin loaded, runs vitest |
| `scripts/validate-live.sh` | Boots a runtime against real Claude (test-mode mocks, no provider credentials) and runs `live.test.ts` |
| `package.json` | Pins `@codespar/types` (exact) and `@copilotkit/aimock` |

There is no `mcp-servers.json` — that's the raw-tool bridge spawn recipe, and a
meta-tool agent never touches it.

## Run

```bash
cd examples/payment-failure-triage
npm install
npm run validate
```

`validate.sh` boots aimock on port 4010, then resolves a runtime (first match
wins): `CODESPAR_BASE_URL` (already-running) → `CODESPAR_RUNTIME_DIR` (local
clone) → `docker` (published image). Each path runs the runtime in test mode with
`CODESPAR_PLUGINS` pointed at this dir's `demo-plugin.mjs`. No Anthropic key and
no provider credentials are needed.

### Image channel — use `:main` until the next runtime release

The meta-tool mock seam and the `CODESPAR_PLUGINS` startup loader reach the
`:latest` image only on a runtime release tag. Until then, point the Docker mode
at the bleeding-edge tag:

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

1. **The taxonomy ships two categories, not the whole space.** Exactly two
   failure categories are demonstrated — `customer_data` (recoverable, ask the
   customer) and `non_recoverable` (escalate to a human). Real payment failures
   span more categories (provider-side outages, risk holds, expired mandates,
   …). This example proves the *routing pattern*; a complete failure taxonomy is
   a documented, deliberate non-goal here.
2. **Provider routing is out of frame by design.** `codespar_pay` owns which PSP
   settles the charge; the agent never selects one. Cross-provider failover is a
   platform concern below this altitude, not an agent judgment, so it is not
   demonstrated here.
3. **aimock fixtures are positional** — they match on `turnIndex` and
   `hasToolResult` (and a per-turn message substring), not full message content.
4. **No streaming variant** — only the unary `session.send()` shape is exercised.
