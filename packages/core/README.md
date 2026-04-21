# @codespar/sdk

Commerce SDK for AI agents — sessions, managed auth, Complete Loop orchestration for Latin American commercial APIs.

## Install

```bash
npm install @codespar/sdk
```

## Usage

```typescript
import { CodeSpar } from "@codespar/sdk";

const cs = new CodeSpar({ apiKey: "ak_..." });

const session = await cs.create("user_123", {
  preset: "brazilian",
  manageConnections: { waitForConnections: true },
  // projectId: "prj_a1b2c3d4e5f6g7h8", // optional — overrides client default, falls back to org's default project
});

// Natural language
const result = await session.send("Charge R$150 via Pix and issue the NF-e");

// Direct tool execution
const charge = await session.execute("ZOOP_CREATE_CHARGE", {
  amount: 150.0,
  payment_type: "pix",
});

// Complete Loop — tools, findTools, and loop are free functions
import { tools, findTools, loop } from "@codespar/sdk";

const available = await tools(session);
const payments = await findTools(session, "payment");

const result = await loop(session, {
  steps: [
    { server: "mcp-zoop", tool: "ZOOP_CREATE_CHARGE", params: { amount: 150, payment_type: "pix" } },
    { server: "mcp-nuvem-fiscal", tool: "NUVEMFISCAL_EMITIR_NFE", params: (prev) => ({ chargeId: prev[0].data }) },
    { server: "mcp-melhor-envio", tool: "MELHORENVIO_GENERATE_LABEL", params: {} },
    { server: "mcp-z-api", tool: "ZAPI_SEND_MESSAGE", params: { text: "Your order is on the way!" } },
  ],
  onStepComplete: (step, r) => console.log(`✓ ${step.tool}`),
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
| `projectId` | `string` | — | Optional `prj_<16alphanum>`. Client-wide default project; sent as `x-codespar-project`. Falls back to the org's default project when omitted. |

### `cs.create(userId, config)`

| Option | Type | Description |
|--------|------|-------------|
| `servers` | `string[]` | MCP servers to connect |
| `preset` | `string` | `"brazilian"`, `"mexican"`, `"argentinian"`, `"colombian"`, `"all"` |
| `manageConnections.waitForConnections` | `boolean` | Block until all servers connected |
| `projectId` | `string` | Optional `prj_<16alphanum>`. Overrides the client-level `projectId`; falls back to the org's default project when both are unset. |

### Session methods

| Method | Description |
|--------|-------------|
| `session.execute(tool, params)` | Execute a specific tool |
| `session.send(message)` | Send natural language message |
| `session.sendStream(message)` | Stream events from a natural language message |
| `session.authorize(serverId)` | Start OAuth flow for a server |
| `session.proxyExecute(request)` | Proxy a raw HTTP call through the session |
| `session.connections()` | List connected servers |
| `session.mcp` | MCP transport URL and headers (when using managed runtime) |
| `session.close()` | Close session |

### Free functions

`tools`, `findTools`, and `loop` are free functions that accept any `SessionBase` — they work with the managed runtime, Managed Agents sessions, and custom runtimes alike.

| Function | Description |
|----------|-------------|
| `tools(session)` | Get all available tools from the session |
| `findTools(session, query)` | Search tools by name or description |
| `loop(session, config)` | Run a Complete Loop workflow |

## Need more?

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
