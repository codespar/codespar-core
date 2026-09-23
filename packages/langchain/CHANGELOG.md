# @codespar/langchain — changelog

## 0.4.7 — 2026-09-23

### Fixed

- `jsonSchemaToZod` no longer changes the meaning of a tool's `input_schema`
  on the way to the model. It converted five types and dropped the rest:
  `enum` became a free `z.string()`, array `items` and nested object
  `properties`/`required` were lost, and `anyOf`/`oneOf`/`allOf`/`$ref`
  fell through to `z.string()` — a `oneOf: [number, string]` amount on a
  payment tool became a plain string. The converter is now recursive and
  covers `enum`/`const`, `items` (and tuples), nested objects with their
  own `required`, `additionalProperties` (`false` → `.strict()`, a schema →
  `.catchall()`, absent → `.passthrough()`), `anyOf`/`oneOf` (→ union),
  `allOf` (→ intersection), local `$ref`, `nullable` and `type: [..,
  "null"]`, `integer`, `minimum`/`maximum`/`exclusive*`/`multipleOf`,
  `minLength`/`maxLength`/`pattern`, the `email`/`uri`/`uuid`/`date-time`/
  `date` formats, `minItems`/`maxItems`, `prefixItems` (and draft-07
  `items: [...]`/`additionalItems`) as tuples, draft-4 boolean
  `exclusiveMinimum`/`exclusiveMaximum`, `default` and `description`. A
  combinator beside a schema's own `type`/`properties` constrains it
  further instead of replacing it, and a `required` key `properties` does
  not declare is still required. A `$ref` resolves to one Zod instance per
  target, so a recursive definition survives a walk of the Zod tree (the
  one LangChain does to describe the tool to the model). A `pattern` JS
  cannot compile marks the field untranslated instead of throwing and
  taking every tool with it. A root `$ref` or a wrapped root still yields
  the object's properties.
- A property in `required` keeps its `default` out of the Zod type: it is
  required, the default is documentation.
- Peer dependency `zod` is `>=3.23.0`; the string formats used need it.
- A construct outside that subset (`not`, `if`/`then`/`else`,
  `patternProperties`, a non-local `$ref`, …) becomes `z.unknown()` with
  the description marked `(schema construct not translated: …)`, never
  `z.string()`: the value reaches the API as sent, and the gap is visible.

### Changed

- Unknown keys on an object without `additionalProperties: false` now pass
  through to the API instead of being stripped; that is what the schema
  declares. LangChain validates a tool's input against its Zod schema
  before `invoke`, so an enum value outside the vocabulary or a missing
  nested required field is now rejected before the call, with a Zod
  error, instead of reaching the API. See the README.
- `jsonSchemaToZod` and `CodeSparLangChainTool.schema` are typed
  `ToolInputSchema`: a `ZodObject`, or a `ZodEffects` over one when the
  root schema carries a combinator beside its properties. Code that read
  `schema.shape` directly narrows first or uses `toolInputShape(schema)`.

### Added

- `jsonSchemaToZodType(schema, root?)`: convert any fragment, not only an
  object root.
