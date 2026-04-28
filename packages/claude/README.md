# @codespar/claude

Claude Agent SDK adapter for CodeSpar — convert session tools to Anthropic Claude tool format.

## Install

```bash
npm install @codespar/claude @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/claude";

const cs = new CodeSpar({ apiKey: "ak_..." });
// Optionally pin to a project: new CodeSpar({ apiKey: "ak_...", projectId: "prj_..." })
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = getTools(session);
```

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `getTools` | `(session: Session) => ClaudeToolWithExecute[]` | Convert all session tools to Claude format with execute handlers |
| `toClaudeTool` | `(tool: Tool, session: Session) => ClaudeToolWithExecute` | Convert a single tool to Claude format with execute handler |
| `getToolDefinitions` | `(session: Session) => ClaudeTool[]` | Get tools as plain Claude API format (without execute, for manual handling) |

### `ClaudeTool`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Tool slug identifier |
| `description` | `string` | Tool description |
| `input_schema` | `Record<string, unknown>` | JSON Schema for tool input |

### `ClaudeToolWithExecute`

Extends `ClaudeTool` with:

| Property | Type | Description |
|----------|------|-------------|
| `execute` | `(input) => Promise<unknown>` | Executes the tool via the session |

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
