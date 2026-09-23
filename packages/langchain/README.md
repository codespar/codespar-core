# @codespar/langchain

LangChain.js adapter for CodeSpar — convert session tools to LangChain StructuredTool format.

## Install

```bash
npm install @codespar/langchain @codespar/sdk zod
```

Peer `zod` is `>=3.25.0`: zod 3.25+ and zod 4 both work. The converter
imports the classic API from `zod/v3`, which both ship, so a project
already on zod 4 keeps its own `zod` and the schemas this package builds
are zod 3 classic schemas, which LangChain accepts.

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/langchain";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to LangChain format |
| `toLangChainTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |
| `jsonSchemaToZod` | Convert a tool's JSON Schema `input_schema` to a Zod object |
| `jsonSchemaToZodType` | Convert any JSON Schema fragment to a Zod type |
| `toolInputShape` / `toolInputObject` | The properties / the object under a tool's `schema`, whichever form it takes |

## Schema fidelity

Each tool's `schema` is the Zod form of the `input_schema` the API
declares, converted without changing its meaning: `enum` is a closed
vocabulary, a nested object keeps its own `required`, `anyOf`/`oneOf` is
a union (a discriminated one when every branch is an object with a common
literal key, the action idiom), `allOf` of objects is one object — keys
only one member declares are taken as is, a key two members declare is
the intersection of both fields, unknown keys follow the stricter member
— and anything else in an `allOf` is an intersection; a local `$ref` is
resolved, `integer`,
`minimum`/`maximum`, `minLength`/`maxLength`/`pattern`, the
`email`/`uri`/`uuid`/`date-time`/`date` formats, `nullable`, `default`
and `description` are carried over.

LangChain validates a tool call's arguments against `schema` before
`invoke` runs. So:

- a value outside an `enum`, a wrong type in a union branch, or a missing
  required field in a nested object is rejected with a Zod error before
  the call reaches CodeSpar;
- keys the schema does not declare pass through to the API unless the
  schema says `additionalProperties: false` (then the object is strict);
- a root schema that carries `anyOf`/`oneOf` beside its `properties`
  (the "one of these keys is required" idiom), or whose root is a union
  of object branches (`oneOf: [{action: "pay", …}, {action: "refund", …}]`),
  yields a `ZodEffects` over an object rather than a bare `ZodObject`: the
  object shows the model every key any branch declares, the union is
  enforced as a rule over it. LangChain accepts both. Since 0.5.0
  `tool.schema` is therefore typed
  `ToolInputSchema` (`ZodObject | ZodEffects<ZodObject>`): read the
  properties with `toolInputShape(tool.schema)` and the object with
  `toolInputObject(tool.schema)` rather than `tool.schema.shape`;
- a construct the converter does not translate (`not`, `if`/`then`/`else`,
  `patternProperties`, a non-local `$ref`, a pattern JS cannot compile, …)
  is marked in the field's description with `(schema construct not
  translated: …)`. The rest of that node — its type, properties, required
  — is still translated; only when nothing else is known does the field
  become `z.unknown()` (a required one still has to be present). The value
  is passed to the API as sent; the API validates the untranslated rule;
- a `default` becomes a Zod default only when the field accepts it (a
  `null` default on a string does not); otherwise the field stays optional
  and the description carries the value.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
