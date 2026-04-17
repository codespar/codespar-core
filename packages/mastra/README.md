# @codespar/mastra

Mastra adapter for CodeSpar — convert session tools to Mastra tool format.

## Install

```bash
npm install @codespar/mastra @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/mastra";

const cs = new CodeSpar({ apiKey: "csk_live_..." });
const session = await cs.sessions.create({ preset: "brazilian" });
const tools = await getTools(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to Mastra format (keyed record) |
| `toMastraTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |

## License

MIT — [codespar.dev](https://codespar.dev)
