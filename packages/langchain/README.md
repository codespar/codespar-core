# @codespar/langchain

LangChain.js adapter for CodeSpar — convert session tools to LangChain StructuredTool format.

## Install

```bash
npm install @codespar/langchain @codespar/sdk zod
```

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
| `jsonSchemaToZod` | Convert JSON Schema to Zod object |

## Need more?

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
