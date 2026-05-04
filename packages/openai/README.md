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
// Optionally pin to a project: new CodeSpar({ apiKey: "ak_...", projectId: "prj_..." })
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = getTools(session);
```

The session itself also exposes the F3.M2 router wrappers — `session.discover(query)`, `session.connectionWizard({...})`, `session.paymentStatus(toolCallId)` — for tool search, connect deep-links, and async settlement correlation.

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

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
