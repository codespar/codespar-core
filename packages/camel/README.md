# @codespar/camel

CAMEL-AI adapter for CodeSpar — convert session tools to CAMEL function format.

## Install

```bash
npm install @codespar/camel @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/camel";

const cs = new CodeSpar({ apiKey: "csk_live_..." });
const session = await cs.sessions.create({ preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to CAMEL format |
| `toCamelTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |

## License

MIT — [codespar.dev](https://codespar.dev)
