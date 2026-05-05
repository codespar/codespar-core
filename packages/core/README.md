# @codespar/sdk

Commerce SDK for AI agents — sessions, managed auth, Complete Loop orchestration for Latin American commercial APIs.

## What's new in 0.9.0

Eight new typed methods on `Session`, grouped by capability:

**Meta-tool wrappers** — neutral input shape, typed payload back, same wire as `session.execute(...)`:

- `session.charge(args)` — INBOUND charges (`codespar_charge`). Buyer pays merchant. Pix BRL via Asaas / MP / iugu / Stone; card USD via Stripe. Distinct from `codespar_pay` (outbound transfers).
- `session.ship(args)` — shipping (`codespar_ship`). One typed entry into Melhor Envio's 3 rails (`action: "label" | "quote" | "track"`).

**Async settlement** — `codespar_charge` / `codespar_pay` return synchronously, but real settlement lands via webhook:

- `session.paymentStatus(toolCallId)` — poll the latest known status (pending → succeeded / failed / refunded). Correlates via the response idempotency_key ↔ provider external_reference.
- `session.paymentStatusStream(toolCallId, { onUpdate?, signal? })` — SSE variant. Snapshot on open, an envelope per state change, heartbeat every 15s, auto-closes 5s after a terminal state. `signal` aborts from the caller side.

**Async verification** — `codespar_kyc` returns the inquiry id; the buyer finishes the hosted flow off-platform:

- `session.verificationStatus(toolCallId)` — poll the disposition (pending → approved / rejected / review / expired).
- `session.verificationStatusStream(toolCallId, { onUpdate?, signal? })` — SSE variant. Same lifecycle as `paymentStatusStream`.

**Tool discovery + connection wizard** (already in 0.4.0, restated for completeness):

- `session.discover(query, options?)` — semantic + lexical tool search across the catalog (`codespar_discover`, pgvector + pg_trgm).
- `session.connectionWizard(options)` — connect deep-link backend (`codespar_manage_connections`). Credentials never travel through this method.

All wrappers call into the same managed runtime as `session.execute(...)`; you get typed payloads instead of hand-rolling the meta-tool envelope.

### Crypto + KYC meta-tools

`codespar_crypto_pay` (Coinbase Commerce + Bitso) and `codespar_kyc` (Persona, Sift, Konduto, Truora) are routable today. The verification half now has a typed wrapper (`session.verificationStatus` / `verificationStatusStream`); a `session.cryptoPay(...)` typed wrapper is not in 0.9.0 — call via raw `session.execute("codespar_crypto_pay", {...})` for now.

```typescript
// Crypto: receive a USDC payment via Coinbase Commerce hosted checkout
const charge = await session.execute("codespar_crypto_pay", {
  amount: 29.9,
  currency: "USDC",
  direction: "receive",
  description: "Order #42",
});
// charge.output.hosted_url → redirect buyer here

// KYC: kick off a Persona identity verification, then poll typed
const inquiry = await session.execute("codespar_kyc", {
  buyer: { email: "alice@example.com", first_name: "Alice", last_name: "Smith" },
  check_type: "identity",
});
const v = await session.verificationStatus(inquiry.tool_call_id);
//        ^^ approved | rejected | review | expired | pending
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
const charge = await session.execute("asaas/create_payment", {
  customer: "cus_xxx",
  billingType: "PIX",
  value: 150,
});

// Complete Loop — tools, findTools, and loop are free functions
import { tools, findTools, loop } from "@codespar/sdk";

const available = await tools(session);
const payments = await findTools(session, "payment");

const result = await loop(session, {
  steps: [
    { tool: "codespar_charge", params: { amount: 150, currency: "BRL", method: "pix", buyer: { name, document: cpf } } },
    { tool: "codespar_invoice", params: (prev) => ({ rail: "nfe", company_id, payment_id: prev[0].data.id }) },
    { tool: "codespar_ship", params: { action: "label", origin, destination, items } },
    { tool: "codespar_notify", params: { recipient: phone, message: "Your order is on the way!" } },
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
| `session.charge(args)` | Inbound charge via `codespar_charge` (typed) — buyer pays merchant |
| `session.ship(args)` | Shipping via `codespar_ship` (typed) — `action: "label" \| "quote" \| "track"` |
| `session.paymentStatus(toolCallId)` | Async settlement status for a `codespar_charge` / `codespar_pay` call |
| `session.paymentStatusStream(toolCallId, opts)` | SSE variant of `paymentStatus`; resolves on terminal |
| `session.verificationStatus(toolCallId)` | Async KYC disposition for a `codespar_kyc` call |
| `session.verificationStatusStream(toolCallId, opts)` | SSE variant of `verificationStatus`; resolves on terminal |
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
