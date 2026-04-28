# @codespar/vercel

Vercel AI SDK adapter for CodeSpar — convert session tools to Vercel AI tool format for use with `generateText`, `streamText`, etc.

## Install

```bash
npm install @codespar/vercel @codespar/sdk ai
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/vercel";
import { generateText } from "ai";

const cs = new CodeSpar({ apiKey: "ak_..." });
// Optionally pin to a project: new CodeSpar({ apiKey: "ak_...", projectId: "prj_..." })
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = getTools(session);

const result = await generateText({
  model: openai("gpt-4o"),
  tools,
  prompt: "Charge R$150 via Pix",
});
```

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `getTools` | `(session: Session) => Record<string, VercelTool>` | Convert all session tools to Vercel AI SDK format |
| `toVercelTool` | `(tool: Tool, session: Session) => VercelTool` | Convert a single CodeSpar tool to Vercel AI SDK format |

### `VercelTool`

| Property | Type | Description |
|----------|------|-------------|
| `description` | `string` | Tool description |
| `parameters` | `Record<string, unknown>` | JSON Schema for tool input |
| `execute` | `(params) => Promise<unknown>` | Executes the tool via the session |

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
