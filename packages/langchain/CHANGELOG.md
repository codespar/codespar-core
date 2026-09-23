# @codespar/langchain — changelog

## 0.5.0 — 2026-09-23

### Fixed

- `jsonSchemaToZod` no longer changes the meaning of a tool's `input_schema`
  on the way to the model. It converted five types and dropped the rest:
  `enum` became a free `z.string()`, array `items` and nested object
  `properties`/`required` were lost, and `anyOf`/`oneOf`/`allOf`/`$ref`
  fell through to `z.string()` — a `oneOf: [number, string]` amount on a
  payment tool became a plain string. The converter is now recursive and
  covers `enum`/`const`, `items` (and tuples), nested objects with their
  own `required`, `additionalProperties` (`false` → `.strict()`, a schema →
  `.catchall()`, absent → `.passthrough()`), `anyOf`/`oneOf` (→ union; a
  discriminated union when every branch is an object with a common literal
  key), `allOf` (objects → one object: keys only one member declares are
  taken as is, a key two members declare is the intersection of both
  fields, unknown keys follow the stricter member; anything else → an
  intersection), local `$ref`, `nullable` and `type: [..,
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
- Peer dependency `zod` is `>=3.25.0`. The converter imports the classic
  API from `zod/v3`, which zod 3.25+ and zod 4 both ship, so either works;
  the string formats used need 3.23, and `zod/v3` needs 3.25.
- A required property whose type would accept `undefined` (an untranslated
  field, a nullable one, a `$ref` to an empty definition) still has to be
  present.
- A construct outside that subset (`not`, `if`/`then`/`else`,
  `patternProperties`, a non-local `$ref`, a pattern JS cannot compile, …)
  marks the field's description `(schema construct not translated: …)`
  while the rest of the node — type, properties, required — is still
  translated, at any depth; only a field with nothing else known becomes
  `z.unknown()`, and a required one still has to be present. Never
  `z.string()`: the value reaches the API as sent, and the gap is visible.
- `allOf` members that are all objects become one object (the OpenAPI
  "extends" idiom) instead of an intersection chain, so three or more
  members keep every property at the root and two members that default
  the same key no longer fail a valid input; a shared key keeps both
  members' rules and a `required` or `additionalProperties: false` on
  either side survives. A root that is a union of object branches shows
  the model every branch's keys and enforces the union as a rule. A root
  intersection is flattened whatever its nesting; a root with no object
  in it is marked, never silently emptied. `allOf` and `anyOf` on the same
  node both apply. `items: false` accepts only the empty array and
  `uniqueItems` rejects duplicates.
- `default` becomes a Zod default only when the field accepts it (a `null`
  default on a string does not); otherwise the field stays optional and
  the description carries the value.

### Changed

- **Breaking (types):** `jsonSchemaToZod` returns, and
  `CodeSparLangChainTool.schema` is, `ToolInputSchema` — a `ZodObject`, or
  a `ZodEffects` over one when the root schema carries `anyOf`/`oneOf`/
  `allOf` beside its `properties`. Code that read `tool.schema.shape`
  directly no longer type-checks; use `toolInputShape(tool.schema)` for
  the properties or `toolInputObject(tool.schema)` for the object. At
  runtime the value is a plain `ZodObject` for every schema without a root
  combinator, and LangChain accepts both forms. This is the minor bump.
- Unknown keys on an object without `additionalProperties: false` now pass
  through to the API instead of being stripped; that is what the schema
  declares. LangChain validates a tool's input against its Zod schema
  before `invoke`, so an enum value outside the vocabulary or a missing
  nested required field is now rejected before the call, with a Zod
  error, instead of reaching the API. See the README.

- `format` is advisory: carried in the description as `(format: …)`, not
  enforced. zod's checks are stricter than a JSON Schema validator's in
  places (a lowercase `t` in a date-time, a quoted e-mail local part, a
  URN), so enforcing them rejected valid input.

### Added

- `jsonSchemaToZodType(schema, root?)`: convert any fragment, not only an
  object root.
- `KEYWORD_SUPPORT` (keyword → `translated` / `advisory` / `marked`),
  `MARKED_KEYWORDS` and `renderKeywordTable()`: the declared subset, the
  map the converter reads. The README's table is rendered from it and a
  test keeps them equal.
- A differential test holds the converter to a JSON Schema validator
  (ajv, draft-07 and 2020-12, formats in "fast" mode) over three corpora:
  the meta-tool input schemas, a fixture per supported keyword and edge
  case, and 104 tool schemas from five MCP servers of the LATAM catalog.
  For every generated input, Zod never rejects what ajv accepts, and
  accepts what ajv rejects only when ajv without the advisory and marked
  keywords accepts it too.

### Fixed during review, found by the differential test

- A self-referencing definition behind `anyOf` (a linked list's
  `next: anyOf[$ref node, null]`), or a `$ref` with a `default`, recursed
  until the stack overflowed: nothing is parsed while converting any more.
  Whether a required field admits `undefined` is decided from the tree,
  and a default on a field that reaches a `$ref` stays in the description.
- A literal key shared by every `oneOf` branch but with a repeated value
  (`version: 1` in both) made the conversion throw, taking every tool
  with it; a discriminated union is used only when the values are
  distinct. `oneOf` enforces "exactly one branch" otherwise.
- `prefixItems` required every position; a shorter array is valid, and
  `minItems`/`maxItems`/`uniqueItems` apply to tuples too.
- `properties`/`required` without `type` rejected non-object values, which
  JSON Schema accepts.
- An `allOf` member's `additionalProperties` now judges only the keys that
  member declares, as JSON Schema does. `false` / `true` subschemas are
  honoured. Siblings of `$ref` apply. A root union with a non-object branch
  keeps its object branches' keys and says what it is.
