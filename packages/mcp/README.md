# @codespar/mcp

MCP transport for CodeSpar — connect Claude Desktop, Cursor, VS Code, and other MCP clients to CodeSpar sessions.

## Install

```bash
npm install @codespar/mcp @codespar/core
```

## Usage

```ts
import { CodeSpar } from "@codespar/core";
import { getMcpConfig, getClaudeDesktopConfig } from "@codespar/mcp";

const cs = new CodeSpar({ apiKey: "ak_..." });
const session = await cs.create("user_123", { preset: "brazilian" });

// Get MCP URL and headers for any client
const { url, headers } = getMcpConfig(session);

// Get Claude Desktop config JSON
const config = getClaudeDesktopConfig(session);
```

## API

| Function | Signature | Description |
|----------|-----------|-------------|
| `getMcpConfig` | `(session: Session) => McpConfig` | Get the MCP transport URL and headers for any MCP-compatible client |
| `getClaudeDesktopConfig` | `(session: Session, serverName?: string) => { mcpServers: ... }` | Generate Claude Desktop configuration (for `claude_desktop_config.json`) |
| `getCursorConfig` | `(session: Session) => { url: string; headers: Record<string, string> }` | Generate Cursor / VS Code MCP configuration |

### `McpConfig`

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | MCP transport URL |
| `headers` | `Record<string, string>` | Auth headers for the transport |

## License

MIT — [codespar.dev](https://codespar.dev)
