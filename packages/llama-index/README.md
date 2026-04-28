# @codespar/llama-index

LlamaIndex.TS adapter for CodeSpar — convert session tools to LlamaIndex FunctionTool format.

## Install

```bash
npm install @codespar/llama-index @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/llama-index";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to LlamaIndex format |
| `toLlamaIndexTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
