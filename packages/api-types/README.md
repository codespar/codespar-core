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

## Versioning

- This package mirrors the `/v1/*` REST surface of `api.codespar.dev`.
- Additive changes (new field, new endpoint schema) → minor bump.
- Breaking changes (field removed, type narrowed) → major bump, shipped alongside a matching backend release.

Keep TS + Python + backend aligned — drift is the loudest way to break trust.
