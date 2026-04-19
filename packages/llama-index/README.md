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

const cs = new CodeSpar({ apiKey: "csk_live_..." });
const session = await cs.sessions.create({ preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to LlamaIndex format |
| `toLlamaIndexTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |

## Need more?

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
