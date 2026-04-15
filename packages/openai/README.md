# @codespar/openai

OpenAI Agents SDK adapter for CodeSpar — convert session tools to OpenAI function calling format.

## Install

```bash
npm install @codespar/openai @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools, handleToolCall } from "@codespar/openai";

const cs = new CodeSpar({ apiKey: "ak_..." });
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = getTools(session);
```

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `getTools` | `(session: Session) => OpenAIFunction[]` | Convert all session tools to OpenAI function calling format |
| `toOpenAITool` | `(tool: Tool) => OpenAIFunction` | Convert a single CodeSpar tool to OpenAI format |
| `handleToolCall` | `(session: Session, functionName: string, args: Record<string, unknown>) => Promise<string>` | Handle a tool call from OpenAI's response and return the JSON-stringified result |

### `OpenAIFunction`

| Property | Type | Description |
|----------|------|-------------|
| `type` | `"function"` | Always `"function"` |
| `function.name` | `string` | Tool slug identifier |
| `function.description` | `string` | Tool description |
| `function.parameters` | `Record<string, unknown>` | JSON Schema for tool input |

## License

MIT — [codespar.dev](https://codespar.dev)
