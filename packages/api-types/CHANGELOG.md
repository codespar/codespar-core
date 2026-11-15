# @codespar/api-types — CHANGELOG

## 0.6.0 — 2026-11-15

### Security

- **zod 4 (GHSA-mrhx-c7xc-m3w5, core#214).** It depends on `zod ^4.6.6`. zod up to 4.6.5, and every 3.x, can exhaust memory while validating an oversized array. The schemas are now zod 4 schemas: the shapes and the inferred types are the same. A consumer that passes them to zod 3 tooling (an OpenAPI generator, for example) or composes them with its own zod 3 schemas has to move to zod 4 when it adopts 0.6.0. That is why the version is a minor: `^0.5.0` does not pick it up.

### Added

- `AuthTypeSchema` contains `two_header` (#72). It landed after 0.5.0 was published and reaches the registry with this version (core#132).
