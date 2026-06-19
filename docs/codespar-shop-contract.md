# `codespar_shop` — contract specification

The canonical, consumer-facing specification of the `codespar_shop` meta-tool:
the buy-side primitive that turns a catalog query into a payable Pix. This
document is the source of truth a lane author or third-party developer reads to
conform — without reading any implementation source. The hand-written wire types
live in `@codespar/types` (`packages/types/src/types.ts`); the typed SDK facade
is `session.shop()` in `@codespar/sdk`.

`codespar_shop` is a **meta-tool**: the typed `session.shop()` facade is a thin
client over `execute("codespar_shop", args)`. It requires a runtime that
**implements** the meta-tool (a registered implementation behind this contract).
A self-hosted runtime with no registered implementation returns
`Tool not registered`.

## Scope boundary (what this contract does NOT do)

The contract stops at minting a payable `pix_copia_e_cola`. It does **not**:

- settle money to the merchant (a returned Pix is a payment *request*, not a
  transfer, and not an approved purchase);
- perform any KYC, mandate, cap, or allowlist check — settlement and its
  governance are a separate tool with separate guarantees;
- define the engine/adapter mechanism or merchant lanes.

Consumers MUST route settlement through the separate payment tool and MUST NOT
treat a returned Pix as an approved purchase.

## Versioning stance

**Unversioned v0 with an additive-compatibility rule.** There is no version
field, header, or negotiation. New **optional** fields may be added to inputs and
outputs without a version bump; a consumer MUST ignore unknown fields. Any
breaking change (removing/renaming a field, tightening a previously-accepted
input) is a deliberate, separately-announced change — see the back-compatibility
note under each tightening below. The `/v1/` in any REST URL namespace is a path
segment, not a contract version.

## Capability token

A session declares the `shop` capability to surface the `session.shop()` method:

```ts
const session = await codespar.create("consumer_123", { capabilities: ["shop"] });
```

The token is **advisory** in this contract: it documents intent and lets a
runtime advertise the surface, but the contract does not mandate that the runtime
reject a `codespar_shop` call from a session that omitted it. A runtime MAY
enforce the capability; the canonical behavior for a session without it is the
same as for any unregistered tool (`Tool not registered`) rather than a
distinct capability error.

## Actions

The action set is **closed**: `search`, `checkout`, `checkout_status`. The
default action is `search`. An unrecognized action is `invalid_args`.

| Action | Purpose | Sync/async |
|---|---|---|
| `search` | Find offers for a query at a merchant | synchronous |
| `checkout` | Start a checkout; returns a session id | async (poll for the result) |
| `checkout_status` | Poll a checkout session to a terminal state | synchronous read |

## Inputs

### `search`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `action` | `"search"` | yes | discriminant |
| `query` | string | yes | free-form query |
| `limit` | integer | no | enforce-clamped to **1..20**, default 10 |
| `merchant` | string | no | open string resolved to a rail at runtime |

`limit` is **enforce-clamped**: an out-of-range value is coerced to the nearest
bound (not rejected). *Back-compat note:* clamping `1..20` is a deliberate
tightening — a caller passing `21..50` previously got the larger page.

### `checkout`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `action` | `"checkout"` | yes | discriminant |
| `merchant` | string | no | open string resolved to a rail at runtime |
| `items` | `ShopCheckoutItem[]` | conditional | the VTEX rail — see "items XOR url" |
| `url` | string | conditional | the Mercado Livre PDP rail — see "items XOR url" |
| `consumer_id` | string | no | buyer scope; defaults to the calling agent's id |
| `buyer` | `ShopBuyer` | no | vaulted buyer profile (merged, inline wins) |
| `address` | `ShopAddress` | no | vaulted delivery address; `cep` required when present |

**items XOR url, gated by rail.** Pass `items` for the VTEX rail OR `url` for the
Mercado Livre product-detail-page rail — not both. Missing the rail-required
field is `invalid_args` (`items_required` for the VTEX path, `meli_url_required`
for the Mercado Livre path).

`ShopCheckoutItem`:

| Field | Type | Req. | Notes |
|---|---|---|---|
| `variant_id` | string | yes | the buyable SKU — pass `ShopVariant.sku_id` here |
| `quantity` | integer | no | defaults to 1 |
| `seller` | string | no | VTEX marketplace sub-seller id for a third-party SKU |

`ShopBuyer`: `name?`, `email?`, `cpf?`, `phone?` — all optional. `ShopAddress`:
`cep` (required when `address` is present), then `street?`, `number?`,
`complement?`, `neighborhood?`, `city?`, `state?`.

**Buyer-identity defaulting.** `consumer_id` is optional and defaults to the
calling agent's id when omitted; it scopes the buyer (e.g. resolving a connected
Mercado Livre account). Optional `buyer`/`address` are merged with the saved
shopper profile for that `consumer_id`, with **inline argument values winning
over vaulted values**; omitted fields fall back to the vaulted profile (and, in
sandbox, to worker defaults). For a Mercado Livre `checkout` where `consumer_id`
is omitted, the scope falls back to the agent id; if no connected account
resolves for that id the checkout cannot proceed on the connected-account path.

### `checkout_status`

| Field | Type | Req. | Notes |
|---|---|---|---|
| `action` | `"checkout_status"` | yes | discriminant |
| `checkout_session_id` | string | yes | the id returned by `checkout` |

## Outputs

### `search` → `ShopSearchResult`

```
{ rail: string, products: ShopOffer[] }
```

A zero-result search is a **success** with `products: []` — not an error.
Consumers branch on emptiness, not exceptions.

`ShopOffer` (flattened — the buyable SKU is reachable directly):

| Field | Type | Notes |
|---|---|---|
| `product_id` | string | the product id — **not** buyable on its own |
| `sku_id` | string? | offer-level SKU when the offer has a single buyable SKU |
| `title` | string? | |
| `price_minor` | integer? | minor units (centavos) |
| `currency` | string? | ISO-4217, default `"BRL"` |
| `image` | string? | |
| `url` | string? | |
| `available` | boolean | |
| `variants` | `ShopVariant[]` | the buyable SKUs |

`ShopVariant`:

| Field | Type | Notes |
|---|---|---|
| `sku_id` | string | the buyable SKU |
| `title` | string? | |
| `price_minor` | integer? | minor units (centavos) |
| `currency` | string? | ISO-4217, default `"BRL"` |
| `available` | boolean | |

**Field-name asymmetry (documented, not a bug).** The search output carries the
buyable SKU as `ShopVariant.sku_id`; the `checkout` input takes that same value
as the item's `variant_id`. Pass `ShopVariant.sku_id` as the checkout item's
`variant_id`. The asymmetry is kept (renaming either field would break existing
callers).

### `checkout` → `ShopCheckoutResult`

```
{ checkout_session_id: string, status: "in_progress", message?: string }
```

Checkout is **always async**: it returns immediately with a session id and the
literal status `in_progress`; the caller then polls `checkout_status`. The
`message` field is an optional, advisory free-text status string. (The previously
advertised-but-unread `paymentMethod` field is **dropped** — Pix is the only
minted rail.)

### `checkout_status` → `ShopStatusResult`

| Field | Type | Notes |
|---|---|---|
| `checkout_session_id` | string | |
| `status` | `ShopCheckoutStatus` | `in_progress` \| `ready_for_payment` \| `canceled` |
| `rail` | string? | |
| `total_minor` | integer? | minor units; present at `ready_for_payment` |
| `pix_copia_e_cola` | string? | the payable Pix; present **only** at `ready_for_payment` |
| `order_status` | string? | |
| `error` | string? | present **only** at `canceled` |

## Checkout-status state machine

```
in_progress ──▶ ready_for_payment   (terminal success: total_minor + pix_copia_e_cola)
      │
      └───────▶ canceled            (terminal failure: error)
```

- `in_progress` — initial, non-terminal.
- `ready_for_payment` — terminal success; carries `total_minor` +
  `pix_copia_e_cola`.
- `canceled` — terminal failure; carries `error`.

Legal transitions: `in_progress → ready_for_payment` and
`in_progress → canceled`. There is **no** transition out of a terminal state.
**Poll-after-terminal** returns the same terminal payload on every poll. There is
**no `expired` status today** — it is explicitly deferred (not introduced by this
contract).

## Error taxonomy

Every contracted error has a stable identifier, the action(s) that can raise it,
the trigger, and the channel it arrives on. **Channel** is either a thrown
tool-failure (`invalid_args` / `provider_error`) or the `error` field on a
`canceled` session.

| Identifier | Actions | Trigger | Channel |
|---|---|---|---|
| `invalid_args` | all | 400-class precondition: missing `query`; the Mercado Livre path with no `url` (`meli_url_required`); the VTEX path with no `items` (`items_required`); missing `checkout_session_id`; unrecognized `action` | thrown |
| `provider_error` | `checkout`, `checkout_status` | any non-400 failure, wrapping worker-raised failures (below) and the `browser_worker_unconfigured` precondition | thrown |
| `browser_worker_unconfigured` | `checkout` | no browser-worker configured for the rail | thrown (as `provider_error`) |
| `browser_worker_failed` | `checkout`, `checkout_status` | generic worker failure | thrown (as `provider_error`) or the `error` field on a `canceled` session |
| `browser_worker_checkout_failed` | `checkout` | worker checkout-drive failure | `provider_error` / `canceled.error` |
| `browser_worker_meli_failed` | `checkout` | worker Mercado Livre path failure | `provider_error` / `canceled.error` |
| `browser_worker_async_start_failed` | `checkout` | worker async-start failure | `provider_error` / `canceled.error` |
| `browser_worker_status_failed` | `checkout_status` | worker status-read failure | `provider_error` / `canceled.error` |

**KYC / account / mandate errors are NOT part of this contract.** They belong to
the separate settlement tool and its governance.

### `vtex_identity_required` — net-new, not a shipped code

`vtex_identity_required` is **not** a shipped error code today. The VTEX
identity-wall fail-fast lives in the external browser-worker service and surfaces
today as an opaque `provider_error` / `browser_worker_checkout_failed`, or a
`canceled` session with a free-text `error`. Promoting it to a first-class,
branchable code requires propagating a stable code from the browser-worker
through the surface — that is net-new contract work, deferred to implementation,
**not** an existing code. This document records the honest state; it does not
assert a code the surface does not yet emit.

## Merchant identification + limits

**Merchant is an open string** resolved to a rail at runtime, not a closed enum:
`meli` / `mercadolivre` / `mercadolibre` (plus spacing/hyphen variants) match a
closed Mercado Livre set; any other slug or domain is treated as a VTEX account
(a catch-all). The four commonly-cited merchants are illustrative, not an
enforced whitelist. Closing the enum is **explicitly NOT done** (it would break
the "any VTEX store" reach); any future tightening is a separate,
compatibility-assessed change.

**Limit:** the enforced bound is `search.limit` **1..20**, enforce-clamped.

**Pagination is deferred — not specified in v0.** There is no page token, cursor,
or offset in this contract. A consumer requests a single page bounded by `limit`.

## Vocabulary crosswalk (Tier 0/1/2 ↔ S1–S6)

Two merchant vocabularies appear in the broader record and classify on
**different axes** — so this is a crosswalk, not a bijection:

- **Tier 0/1/2** classifies by integration depth / execution rail: Tier 0
  hosted-browser scrape, Tier 1 connected API, Tier 2 native catalog.
- **S1–S6** classifies by how the agent transacts (storefront shapes).

A single merchant platform (e.g. VTEX) spans tiers, so the axes do not map 1:1.

| Tier | Integration depth | Crosswalk to S-shapes |
|---|---|---|
| Tier 0 | hosted-browser scrape (drive the store's real checkout headlessly) | maps to whichever S-shape the scraped storefront presents — no fixed S-row |
| Tier 1 | connected upstream API | maps to the connected-API S-shapes; one platform can appear at Tier 0 and Tier 1 |
| Tier 2 | native catalog / native checkout | maps to the native-listing S-shapes |

**Neither vocabulary is normative for the wire shape.** The `codespar_shop` wire
shape is **rail-tagged via the `rail` field**, not tier-tagged or shape-tagged.
Tier and S-shape are lane/coverage lenses; they do not change the actions,
schemas, or status values this contract defines.

## Cross-registrant obligations

Every implementation registered behind this contract MUST honor the following.
These are part of the contract even where enforcement is the registrant's
responsibility.

### PII / Pix log-redaction

`buyer.*`, `address.*`, `cpf`, `consumer_id`, and `pix_copia_e_cola` are
sensitive. `cpf` and contact/address fields are personal data; `pix_copia_e_cola`
is a payable bearer instrument anyone who reads it from a log can attempt to pay
or substitute. All of these MUST be **redacted from logs by default** and MUST
**NOT** be echoed in `error` strings. A `provider_error` wrapping a worker
failure MUST sanitize internal hostnames and stack detail before it crosses the
boundary.

### Abort handling

A checkout is a multi-second/minute job. On caller abort (client disconnect,
timeout) a registrant **SHOULD** honor the abort signal to cancel in-flight
provider work, and **MUST** treat an aborted checkout as **non-authoritative** —
no orphaned-order or cost-amplification assumption is safe.

### Session + buyer authorization

A registrant MUST authorize `checkout_session_id` against the calling session's
tenant/principal before returning session state: a session minted under one
tenant/consumer MUST NOT be readable by another (unguessable ids are not the
authorization boundary). Symmetrically, when `consumer_id` is supplied the
registrant MUST authorize it against the session's principal — an agent may act
only for consumer scopes it is entitled to.

## Typed SDK surface

- **TypeScript** (`@codespar/sdk`): `session.shop(args: ShopArgs):
  Promise<ShopResult>`, mirroring `session.charge()` — it calls
  `execute("codespar_shop", args)`, throws `shop failed: <error>` on `!success`,
  and returns the typed result. `ShopArgs`/`ShopResult` are discriminated on
  `action`, so a caller gets the action-correct result type without an untyped
  cast: a `ready_for_payment` status exposes typed `pix_copia_e_cola` +
  `total_minor`; a `canceled` status exposes typed `error`.
- **Python** (`codespar` on PyPI): dataclass `ShopArgs`/`ShopResult` (+ nested
  offer/variant/status types) in `types.py`, a dict→dataclass parse helper that
  maps the wire fields one-to-one, and async + sync `shop()` wrappers —
  version-locked to the TypeScript SDK with the same field names and per-field
  optionality.

The types are hand-written (no Zod, no codegen), consistent with the rest of the
meta-tool surface. Any wire-shape change is a 3-way edit (TS types, Python types,
backend route).

## Usage example

```ts
const session = await codespar.create("consumer_123", { capabilities: ["shop"] });

const search = await session.shop({
  action: "search",
  query: "ração para gato",
  merchant: "cobasi",
  limit: 10,
});
// search.products[0].variants[0].sku_id is the buyable SKU

const { checkout_session_id } = await session.shop({
  action: "checkout",
  merchant: "cobasi",
  items: [{ variant_id: search.products[0].variants[0].sku_id, quantity: 1 }],
  consumer_id: "consumer_123",
});

// poll until terminal
let status = await session.shop({ action: "checkout_status", checkout_session_id });
if (status.status === "ready_for_payment") {
  // status.pix_copia_e_cola is the payable Pix; settle it via the payment tool
}
```
