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
| `baseUrl` | `string` | `CODESPAR_BASE_URL` env, else `https://api.codespar.dev` | API base URL. Set `CODESPAR_BASE_URL=http://localhost:8000` to point the SDK at a [local OSS runtime](https://github.com/codespar/codespar); the managed backend is the default. |
| `managed` | `boolean` | `true` | Enable managed billing/logging |
| `projectId` | `string` | — | Optional `prj_<16alphanum>`. Client-wide default project; sent as `x-codespar-project`. Falls back to the org's default project when omitted. |

### `cs.create(userId, config)`

| Option | Type | Description |
|--------|------|-------------|
| `servers` | `string[]` | MCP servers to connect |
| `preset` | `string` | `"brazilian"`, `"mexican"`, `"argentinian"`, `"colombian"`, `"all"` |
| `manageConnections.waitForConnections` | `boolean` | Block until all servers connected |
| `projectId` | `string` | Optional `prj_<16alphanum>`. Overrides the client-level `projectId`; falls back to the org's default project when both are unset. |
| `mocks` | `Record<string, MockValue>` | Optional test-mode mocks. See [Test-mode mocks](#test-mode-mocks). |

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

## Test-mode mocks

Skip live providers in tests by passing a `mocks` map to `cs.create`. Keys are canonical tool names in slash form (`asaas/create_payment`, `melhor-envio/calculate_shipping`, …). Values are either a single object — used as the response on every matching call — or an array of objects consumed in order, returning `mocks_exhausted` once the list drains.

```typescript
import { CodeSpar } from "@codespar/sdk";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY });

const session = await cs.create("user_test", {
  servers: ["asaas"],
  mocks: {
    "asaas/create_payment": { id: "pay_test", status: "PENDING" },
  },
});

const result = await session.execute("asaas/create_payment", { value: 100 });
// result.data === { id: "pay_test", status: "PENDING" }
```

Pass an array for stateful mocks:

```typescript
mocks: {
  "asaas/create_payment": [
    { id: "pay_1", status: "PENDING" },
    { id: "pay_1", status: "RECEIVED" },
  ],
}
```

Mocks live behind the managed backend's test-mode gate — a `csk_test_*` API key against a `test`-environment project. Live keys against the same map return `mocks_not_permitted`. The SDK forwards keys verbatim; if you send the OSS double-underscore form (`asaas__create_payment`) the backend rejects with `mocks_invalid` rather than the SDK silently rewriting.

The OSS runtime accepts the same `mocks` shape on its session API (see [codespar/codespar#113](https://github.com/codespar/codespar/pull/113)), so the same test fixtures work whether you point at `api.codespar.dev` or a self-hosted instance via `CODESPAR_BASE_URL`. Self-hosted runtimes must additionally set `CODESPAR_TEST_MODE_ENABLED=true` on the server process; without it, the SDK receives `mocks_not_permitted` / HTTP 501 instead of fixture responses.

Storage shape differs by runtime — the wire contract does not. The managed backend persists mocks and per-tool consume counters; sessions and their fixtures survive restarts and multi-replica deployments. The OSS runtime holds both in process memory; they are scoped to the HTTP-session process and are lost on restart, and channel-bridge sessions (WhatsApp, Slack, Telegram, Discord) cannot carry mocks under the OSS shape. Response envelopes, status codes, sibling fields, and gate ordering are byte-identical between runtimes regardless. See [the test-mode concept doc](https://docs.codespar.dev/concepts/test-mode) for the full per-runtime split.

Test mode is a property of the runtime, not the session. On the managed backend it's `project.environment === 'test'`; on a self-hosted OSS runtime it's `CODESPAR_TEST_MODE_ENABLED=true` on the server process. When the runtime is in test mode, every external tool call your code or LLM dispatches must match a declared mock — unmatched calls return `tool_not_mocked` (HTTP 422 on the catalog-routed `/execute` path; a `tool_result` block on the chat-loop) and no upstream provider runs. The envelope covers three failure modes: the `mocks` map has no entry for the canonical name, the session was created with no `mocks` field, or the canonical name has an unknown server prefix. A session that doesn't declare `mocks` can't dispatch any tools in test mode; declare the mocks the test will exercise, or run the same code against a live-mode runtime where the real providers handle dispatch. Built-in metadata tools — `codespar_list_tools` on OSS, `codespar_discover` and `codespar_manage_connections` on the managed backend — bypass this gate.

### Type aliases

`MockObject` (`Record<string, unknown>`) and `MockValue` (`MockObject | MockObject[]`) ship from `@codespar/types` and re-export through `@codespar/sdk`. Use them when you want to define mock fixtures separately from the `create` call site.

```typescript
import type { MockValue } from "@codespar/sdk";

const fixtures: Record<string, MockValue> = {
  "asaas/create_payment": { id: "pay_test", status: "PENDING" },
};
```

## Typed errors

Every transport failure from `createSession`, `proxyExecute`, `send`, `sendStream`, `paymentStatus(Stream)`, `verificationStatus(Stream)`, and `authorize` throws a `CodesparApiError` with a structured `code` field. The old `e.message.includes("foo")` pattern is gone — branch on `e.code` instead.

```typescript
import { CodesparApiError } from "@codespar/sdk";

try {
  await cs.create("user_test", { mocks: { "asaas/create_payment": {} } });
} catch (err) {
  if (err instanceof CodesparApiError) {
    if (err.code === "mocks_not_permitted") {
      // Live key against a mocks map. Swap to csk_test_*.
    } else if (err.code === "mocks_invalid") {
      // Backend rejected a tool-name key. Check the slash form.
    } else if (err.status === 0) {
      // Network never reached the backend; err.cause has the fetch rejection.
    }
    throw err;
  }
}
```

`session.execute` keeps its returns-vs-throws asymmetry: tool failures come back as `ToolResult.success === false` with the body on `error`. Only transport-level failures throw.

### Tool-result guards

The five reserved tool-result codes (`policy_denied`, `approval_required`, `mocks_exhausted`, `mocks_engine_error`, `tool_not_mocked`) ship typed guards plus an exhaustive-match helper. Guards run against any `unknown` payload — both `ToolResult.data` from `session.execute` and `ToolCallRecord.output` from `send` / `sendStream`. Each guard checks the `code` discriminant AND the variant's required sibling fields, so a malformed payload returns false rather than narrowing positive on the code alone.

```typescript
import {
  isApprovalRequired,
  isMocksEngineError,
  isMocksExhausted,
  isPolicyDenied,
  isToolNotMocked,
  assertExhaustiveToolResult,
  ToolResultCode,
} from "@codespar/sdk";

const result = await session.execute("asaas/create_payment", { value: 100 });

if (isPolicyDenied(result.data)) {
  console.warn(`blocked by ${result.data.rule_id}: ${result.data.message}`);
} else if (isApprovalRequired(result.data)) {
  console.log(`needs approval ${result.data.approval_id} by ${result.data.expires_at}`);
} else if (isMocksExhausted(result.data)) {
  // Stateful mock array drained — pad it or extend the test.
} else if (isMocksEngineError(result.data)) {
  // Backend-side mocks engine failure; usually a malformed fixture.
} else if (isToolNotMocked(result.data)) {
  console.warn(`no mock for ${result.data.tool_name}`);
}
```

The same guards apply inside a `sendStream` loop against `event.toolCall.output`.

When a `switch` over `ToolResultCode` covers every variant, call `assertExhaustiveToolResult` in the default branch. TypeScript fails to compile if a sixth code lands without a matching arm.

```typescript
function handle(outcome: ToolResultOutcome): string {
  switch (outcome.code) {
    case ToolResultCode.PolicyDenied: return outcome.rule_id;
    case ToolResultCode.ApprovalRequired: return outcome.approval_id;
    case ToolResultCode.MocksExhausted: return "exhausted";
    case ToolResultCode.MocksEngineError: return "engine";
    case ToolResultCode.ToolNotMocked: return outcome.tool_name;
    default: return assertExhaustiveToolResult(outcome);
  }
}
```

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
