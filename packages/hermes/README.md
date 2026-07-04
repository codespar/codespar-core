# @codespar/hermes

> **Not yet published to npm.** This package builds from source in this repo; the install command below will not resolve until the first npm release lands.

Hermes Agent (Nous Research) adapter for CodeSpar — convert session tools to Hermes's MCP/plugin tool format.

Hermes agents ship with a Privy-secured embedded wallet and credit billing but **no commerce rail**. This adapter gives them LATAM commerce (pay / charge / invoice / ship / notify) routed through a CodeSpar session for billing and audit.

## Install

```bash
npm install @codespar/hermes @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getTools } from "@codespar/hermes";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
const session = await cs.create("user_123", { preset: "brazilian" });
const tools = await getTools(session);

// Register the tools with your Hermes plugin / MCP bridge.
for (const tool of tools) {
  plugin.registerTool(tool);
}
```

## Tool shape

Each `HermesTool` mirrors the [MCP tool spec](https://modelcontextprotocol.io) — the format Hermes uses to ingest external tools via plugins and MCP servers:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name (e.g. `codespar_pay`) |
| `description` | `string` | Human/agent-readable description |
| `inputSchema` | `Record<string, unknown>` | JSON Schema for the tool's arguments |
| `call` | `(input) => Promise<string>` | Async invoke; routes through `session.execute` and returns the serialized result |

We chose the MCP-aligned shape (`name` / `description` / `inputSchema` + async `call` returning a string) over a Hermes-proprietary plugin shape because Hermes ingests external tools primarily through MCP servers, so this is the most portable contract.

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to Hermes format |
| `toHermesTool` | Convert a single tool |
| `handleToolCall` | Execute a tool call via the session |

## Connect via MCP server (no npm install)

Because Hermes natively connects **MCP servers**, you can also expose CodeSpar's commerce tools to a Hermes agent without installing this package — point Hermes at the session's MCP endpoint:

```ts
import { CodeSpar } from "@codespar/sdk";
import { getMcpConfig } from "@codespar/mcp";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
const session = await cs.create("user_123", { preset: "brazilian" });

const { url, headers } = getMcpConfig(session);
// Add this URL + headers as an MCP server in your Hermes config.
```

Add the resulting `url` (with auth `headers`) as an MCP server in Hermes (`~/.hermes/` config / MCP servers section). Use this adapter package when you want in-process tool objects; use the MCP-server path when you want the paste-URL, zero-dependency integration.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
