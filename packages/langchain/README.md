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

const cs = new CodeSpar({ apiKey: "csk_live_..." });
const session = await cs.sessions.create({ preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to LangChain format |
| `toLangChainTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |
| `jsonSchemaToZod` | Convert JSON Schema to Zod object |

## License

MIT — [codespar.dev](https://codespar.dev)
