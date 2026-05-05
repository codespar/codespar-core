# @codespar/api-types

Shared REST wire contract for the CodeSpar managed-tier API at `api.codespar.dev`.

Every request body and response shape is defined once, as a Zod schema, and the matching TypeScript type is inferred from it. Both the backend (`codespar-enterprise`) and the dashboard (`codespar-web`) import from here — no more hand-rolled mirror types.

## Why

Two bugs shipped in a 48-hour window because web and backend independently redeclared the same response types:

- Newly-created API keys rendered as "Revoked" (`revoked_at` omitted on the create response, web type assumed present, `undefined !== null` was truthy).
- API-key list came back empty (backend returns `{ keys: [...] }`, web parsed `data.api_keys`).

Schemas here are the single source of truth. Parse responses at the fetch boundary and these failures become impossible — missing/renamed fields throw at runtime instead of rendering broken UI.

## Usage

```ts
import {
  ApiKeyRowSchema,
  ListApiKeysResponseSchema,
  type ListApiKeysResponse,
} from "@codespar/api-types";

const res = await fetch("/v1/api-keys", { headers: { authorization: `Bearer ${token}` } });
const body: ListApiKeysResponse = ListApiKeysResponseSchema.parse(await res.json());
//    ^^^^ throws ZodError if the backend drifts
```

Every module exports both the schema (`FooSchema`) and the inferred type (`Foo`). Import whichever side you need.

## Coverage

- `api-keys` — create / list / row
- `projects` — create / update / list / row
- `connections` — create / list / row / webhook-secret rotation
- `servers` — list / row / auth-schema
- `sessions` — create / list / row / detail / tool-calls / execute

### `auth_type` enum

A connection's `auth_type` determines how credentials are stored and
forwarded to the upstream provider. As of 0.4.0 the enum has six
values:

| Value | Used by |
|---|---|
| `api_key` | Most providers — Asaas, Mercado Pago, NFe.io, Stripe, etc. |
| `path_secret` | Z-API-style providers that embed credentials in the URL path with a companion header. |
| `oauth` | Providers requiring an OAuth flow (e.g. user-authorized integrations). |
| `cert` | mTLS — BR open-banking pilots (BB live; Itaú / Santander / Bradesco / Caixa next). |
| `hmac_signed` | Foxbit + LATAM crypto exchanges that sign each request with a derived HMAC. |
| `none` | Public APIs / no credentials. |

### What's new in 0.4.0

Adds the `cert` and `hmac_signed` `auth_type` values to the connection
schemas — the contract now covers BR open-banking mTLS pilots and
HMAC-signed crypto exchange APIs alongside the original four.

> **Known limitation.** `AuthSchemaFieldKindSchema` (the `kind` enum
> for individual fields inside an auth schema) does NOT yet include
> `hmac` — only the connection-level `auth_type` enum does. The
> dashboard's `ProviderConnectModal` works around this by tagging
> HMAC-signed fields as `path_secret` kind. Consumers reading auth
> schemas directly should expect this mismatch until a future minor
> bump tightens the field-kind enum.

## Versioning

- This package mirrors the `/v1/*` REST surface of `api.codespar.dev`.
- Additive changes (new field, new endpoint schema) → minor bump.
- Breaking changes (field removed, type narrowed) → major bump, shipped alongside a matching backend release.

Keep TS + Python + backend aligned — drift is the loudest way to break trust.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
