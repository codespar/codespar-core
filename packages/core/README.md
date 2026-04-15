# @codespar/core

Commerce SDK for AI agents — sessions, managed auth, Complete Loop orchestration for Latin American commercial APIs.

## Install

```bash
npm install @codespar/core
```

## Usage

```typescript
import { CodeSpar } from "@codespar/core";

const cs = new CodeSpar({ apiKey: "ak_..." });

const session = await cs.create("user_123", {
  preset: "brazilian",
  manageConnections: { waitForConnections: true },
});

// Natural language
const result = await session.send("Charge R$150 via Pix and issue the NF-e");

// Direct tool execution
const charge = await session.execute("ZOOP_CREATE_CHARGE", {
  amount: 150.0,
  payment_type: "pix",
});

// Complete Loop
const loop = await session.loop({
  steps: [
    { server: "mcp-zoop", tool: "ZOOP_CREATE_CHARGE", params: { amount: 150, payment_type: "pix" } },
    { server: "mcp-nuvem-fiscal", tool: "NUVEMFISCAL_EMITIR_NFE", params: (prev) => ({ chargeId: prev[0].data }) },
    { server: "mcp-melhor-envio", tool: "MELHORENVIO_GENERATE_LABEL", params: {} },
    { server: "mcp-z-api", tool: "ZAPI_SEND_MESSAGE", params: { text: "Your order is on the way!" } },
  ],
  onStepComplete: (step, result) => console.log(`✓ ${step.tool}`),
  retryPolicy: { maxRetries: 3, backoff: "exponential" },
});
```

## API

### `new CodeSpar(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | `CODESPAR_API_KEY` env | Your API key |
| `baseUrl` | `string` | `https://api.codespar.dev` | API base URL |
| `managed` | `boolean` | `true` | Enable managed billing/logging |

### `cs.create(userId, config)`

| Option | Type | Description |
|--------|------|-------------|
| `servers` | `string[]` | MCP servers to connect |
| `preset` | `string` | `"brazilian"`, `"mexican"`, `"argentinian"`, `"colombian"`, `"all"` |
| `manageConnections.waitForConnections` | `boolean` | Block until all servers connected |

### Session Methods

| Method | Description |
|--------|-------------|
| `session.tools()` | Get all available tools |
| `session.findTools(intent)` | Search tools by description |
| `session.execute(tool, params)` | Execute a specific tool |
| `session.send(message)` | Send natural language message |
| `session.loop(config)` | Run Complete Loop workflow |
| `session.authorize(serverId)` | Start OAuth flow for a server |
| `session.connections()` | List connected servers |
| `session.mcp` | MCP transport URL and headers |
| `session.close()` | Close session |

## License

MIT — [codespar.dev](https://codespar.dev)
