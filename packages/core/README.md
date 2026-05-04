# @codespar/sdk

Commerce SDK for AI agents — sessions, managed auth, Complete Loop orchestration for Latin American commercial APIs.

## What's new in 0.5.0

Typed wrappers for the F3.M2 meta-tool router:

- `session.discover(query, options?)` — find the right tool for a free-form use case (`codespar_discover`).
- `session.connectionWizard(options)` — surface the connect deep-link when a needed server is disconnected (`codespar_manage_connections`). Credentials never travel through this method.
- `session.paymentStatus(toolCallId)` — correlate webhook settlement back to the originating `codespar_pay` call via the response idempotency key.

All three call into the same managed runtime as `session.execute(...)`; the wrappers just give you the typed payload shape without hand-rolling the meta-tool envelope.

### Crypto + KYC meta-tools (raw `execute()` only)

Two newer meta-tools — `codespar_crypto_pay` (USDC/USDT/BTC across mainnet + L2s) and `codespar_kyc` (Persona / Sift / etc identity + risk verification) — are callable today via raw `session.execute(...)`. Typed SDK wrappers will land in a future release once at least 2 transforms per meta-tool are live in prod.

```typescript
// Crypto: receive a USDC payment via Coinbase Commerce hosted checkout
const charge = await session.execute("codespar_crypto_pay", {
  amount: 29.9,
  currency: "USDC",
  direction: "receive",
  description: "Order #42",
});
// charge.output.hosted_url → redirect buyer here

// KYC: kick off a Persona identity verification
const inquiry = await session.execute("codespar_kyc", {
  buyer: { email: "alice@example.com", first_name: "Alice", last_name: "Smith" },
  check_type: "identity",
});
// inquiry.output.verification_id → poll for completion
```

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
    { tool: "ZOOP_CREATE_CHARGE", params: { amount: 150, payment_type: "pix" } },
    { tool: "NUVEMFISCAL_EMITIR_NFE", params: (prev) => ({ chargeId: prev[0].data }) },
    { tool: "MELHORENVIO_GENERATE_LABEL", params: {} },
    { tool: "ZAPI_SEND_MESSAGE", params: { text: "Your order is on the way!" } },
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
| `session.discover(query, options?)` | Tool search via `codespar_discover` (typed) |
| `session.connectionWizard(options)` | Connect deep-link via `codespar_manage_connections` (typed) |
| `session.paymentStatus(toolCallId)` | Async settlement status for a `codespar_pay` call |
| `session.mcp` | MCP transport URL and headers (when using managed runtime) |
| `session.close()` | Close session |

### Free functions

`tools`, `findTools`, and `loop` are free functions that accept any `SessionBase` — they work with the managed runtime, Managed Agents sessions, and custom runtimes alike.

| Function | Description |
|----------|-------------|
| `tools(session)` | Get all available tools from the session |
| `findTools(session, query)` | Search tools by name or description |
| `loop(session, config)` | Run a Complete Loop workflow |

## Migrating from 0.2.x

`tools`, `findTools`, and `loop` moved from session instance methods to free functions in 0.3.0.

```typescript
// 0.2.x
const tools = await session.tools();
const found = await session.findTools("payment");
const result = await session.loop({ steps: [...] });

// 0.3.0
import { tools, findTools, loop } from "@codespar/sdk";
const available = await tools(session);
const found = await findTools(session, "payment");
const result = await loop(session, { steps: [...] });
```

## Multi-environment (projects)

CodeSpar orgs have a second tenancy tier — **projects** — so dev / staging / prod each get isolated API keys, connected accounts, triggers, and sessions while billing stays at the org level. Every request accepts an optional `x-codespar-project: prj_<16 hex>` header; omit it and the backend resolves the org's default project (self-healed on first read).

Pin the whole client to one environment:

```typescript
const cs = new CodeSpar({
  apiKey: process.env.CODESPAR_API_KEY!,
  projectId: "prj_staging0123abcd", // every session this client spawns scopes here
});
```

Or override per session:

```typescript
const session = await cs.create("user_123", {
  preset: "brazilian",
  projectId: "prj_prod0123abcd", // overrides the client default
});
```

Precedence: `sessionConfig.projectId` > `clientConfig.projectId` > backend's org default. Format is validated at construction via Zod (`/^prj_[A-Za-z0-9]{16}$/`) so typos fail fast. See the [Projects concept doc](https://docs.codespar.dev/concepts/projects) for the full tenancy model.

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
