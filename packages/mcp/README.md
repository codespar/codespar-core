# @codespar/mcp

MCP server for CodeSpar — give Claude, Codex, Cursor, VS Code (and any MCP client)
a Latin-American commerce agent: search & checkout, Pix, wallet/balance, spend
mandates & limits, and Pomelo card issuing — all as MCP tools.

## Run as a server (`codespar-mcp`)

A stdio MCP server that bridges your MCP client to a CodeSpar session's tools. It
talks to the CodeSpar REST API directly, so it works against the live meta-tools
today (`codespar_pay`, `codespar_charge`, `codespar_discover`, wallet, mandates,
and `codespar_issue` → Pomelo card). One env var (`CODESPAR_API_KEY`) and you're in.

**Claude Code / Claude Desktop**

```bash
claude mcp add codespar -- npx -y @codespar/mcp
# then set CODESPAR_API_KEY in the server's env
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.codespar]
command = "npx"
args = ["-y", "@codespar/mcp"]
env = { CODESPAR_API_KEY = "csk_live_...", CODESPAR_PRESET = "brazilian" }
```

**Cursor / VS Code** — `{ "command": "npx", "args": ["-y", "@codespar/mcp"], "env": { "CODESPAR_API_KEY": "csk_live_..." } }`

Config (env or `--flag`): `CODESPAR_API_KEY` (required), `CODESPAR_PROJECT` (`prj_…`),
`CODESPAR_PRESET` (`brazilian`|`mexican`|`argentinian`|`colombian`|`all`, default
`brazilian`), `CODESPAR_SERVERS` (comma list, overrides preset), `CODESPAR_USER_ID`.

## Scopes: what the key decides

The API enforces every scope; this server widens nothing. At boot it opens a
session, and the answer decides what `tools/list` offers:

| Answer to `POST /v1/sessions` | What the server does |
|---|---|
| session | the session's commerce tools (`codespar_pay`, `codespar_charge`, `codespar_discover`, wallet, mandates, Shop purchases) plus `codespar_payables` and `codespar_documents` |
| `403` (valid key without `sessions:create`) | no session: only `codespar_payables` and `codespar_documents`, which run over REST; a session tool called by name answers that the key lacks `sessions:create` |

A document (`codespar_documents`, or a `codespar_wallet` `receipt_document` / `statement_document`) comes back as its JSON reference plus the document itself: a receipt's PNG as an image block, a PDF as an embedded resource (`codespar://documents/…`), up to 4 MiB.
| `401` (wrong, revoked or other-environment key) | setup mode |

| Tools | Scope the key needs |
|---|---|
| session tools | `sessions:create` (and `tools:execute` to call them) |
| `codespar_payables` `upload`, `create_batch`, `get`, `update_item`, `set_rail`, `discard` | `payables:read` / `payables:write` |
| `codespar_payables` `pay` | `payables:pay` |

Inside `codespar_payables`, a `403` is rendered as `insufficient permission (403): …`
with the API's message naming the scope, and a `401` as `credential invalid or
revoked (401): …`, so an agent never retries a missing scope as a broken key.

## Use as a config helper (library)

```bash
npm install @codespar/mcp @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getMcpConfig, getClaudeDesktopConfig } from "@codespar/mcp";

const cs = new CodeSpar({ apiKey: "ak_..." });
// Optionally pin to a project: new CodeSpar({ apiKey: "ak_...", projectId: "prj_..." })
const session = await cs.create("user_123", { preset: "brazilian" });

// Get MCP URL and headers for any client
const { url, headers } = getMcpConfig(session);

// Get Claude Desktop config JSON
const config = getClaudeDesktopConfig(session);
```

The session itself also exposes the meta-tool router wrappers — `session.discover(query)`, `session.connectionWizard({...})`, `session.paymentStatus(toolCallId)` — for tool search, connect deep-links, and async settlement correlation.

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

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
