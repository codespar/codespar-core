# code\<spar\> SDK

Commerce infrastructure for AI agents. Payments, invoicing, shipping, notifications, and ERP across Latin America — one SDK.

LATAM-first by design: Pix + NF-e + WhatsApp + PSP routing are first-class, with MCP servers for the rails (Zoop, Nuvem Fiscal, Melhor Envio, Z-API, Omie, and more) curated in [`codespar/mcp-dev-latam`](https://github.com/codespar/mcp-dev-latam). Any framework, any agent — channel-agnostic by design.

## Packages

**Core**

| Package | Description |
|---------|-------------|
| [`@codespar/sdk`](packages/core) | Sessions, managed auth, tool execution, Complete Loop orchestration |
| [`codespar` (PyPI)](packages/python) | Python SDK — same surface as `@codespar/sdk`, sync + async |
| [`@codespar/types`](packages/types) | Zero-dependency `SessionBase`/`Session` interface hierarchy and conformance test suite |
| [`@codespar/api-types`](packages/api-types) | Shared REST wire contract — Zod schemas + inferred TypeScript types for `api.codespar.dev` |
| [`@codespar/managed-agents-adapter`](packages/managed-agents-adapter) | Anthropic Managed Agents adapter — runs `SessionBase` tools against Managed Agents sessions |
| [`@codespar/cli`](packages/cli) | Command-line interface — auth, execute, sessions, scaffolding |
| [`@codespar/mcp`](packages/mcp) | MCP transport for Claude Desktop, Cursor, VS Code |

**Framework adapters** — convert session tools to your framework's tool format

| Package | Framework |
|---------|-----------|
| [`@codespar/vercel`](packages/vercel) | Vercel AI SDK |
| [`@codespar/claude`](packages/claude) | Claude Agent SDK |
| [`@codespar/openai`](packages/openai) | OpenAI Agents SDK |
| [`@codespar/langchain`](packages/langchain) | LangChain.js |
| [`@codespar/llama-index`](packages/llama-index) | LlamaIndex.TS |
| [`@codespar/google-genai`](packages/google-genai) | Google Gemini / GenAI |
| [`@codespar/mastra`](packages/mastra) | Mastra |
| [`@codespar/crewai`](packages/crewai) | CrewAI |
| [`@codespar/autogen`](packages/autogen) | Microsoft AutoGen |
| [`@codespar/camel`](packages/camel) | CAMEL-AI |
| [`@codespar/letta`](packages/letta) | Letta (MemGPT) |

## Quick Start

```bash
npm install @codespar/sdk   # currently 0.9.0
```

```typescript
import { CodeSpar } from "@codespar/sdk";

const cs = new CodeSpar({ apiKey: "ak_..." });

// Create a session with the Brazilian commerce preset.
// `preset: "brazilian"` resolves to a curated set of MCP servers
// covering Pix charges (Zoop), NF-e issuance (Nuvem Fiscal), shipping
// labels (Melhor Envio), WhatsApp (Z-API), and ERP (Omie). Swap the
// preset or pass `servers: [...]` explicitly to customize.
const session = await cs.create("user_123", {
  preset: "brazilian",
  manageConnections: { waitForConnections: true },
  // projectId: "prj_a1b2c3d4e5f6g7h8", // optional — defaults to the org's default project
});

// Natural language
const result = await session.send(
  "Charge R$150 via Pix and issue the NF-e"
);

// Or execute tools directly
const charge = await session.execute("asaas/create_payment", {
  customer: "cus_xxx",
  billingType: "PIX",
  value: 150,
});

// Don't know which tool to call? Discover by use case (F3.M2 Tool Router).
// Returns recommended + related, plus connection status so the agent knows
// whether to set anything up first.
const found = await session.discover("send a pix payment");
console.log(found.recommended);
//   { server_id, tool_name, connection_status, known_pitfalls, ... }

// Surface the connect wizard when a needed server is disconnected.
// Returns a deep-link the UI renders into a Connect button — the agent
// never receives credentials directly.
const wizard = await session.connectionWizard({
  action: "initiate",
  server_id: found.recommended!.server_id,
});
console.log(wizard.initiate?.connect_url);

// Typed meta-tool wrappers — same wire as session.execute("codespar_charge", ...)
// but you get a typed payload back instead of the generic ToolResult envelope.
const charge = await session.charge({
  amount: 150,
  currency: "BRL",
  method: "pix",
  buyer: { name: "Cliente Demo", document: "11144477735" },
});
const label = await session.ship({
  action: "label",
  origin: { /* ... */ },
  destination: { /* ... */ },
  items: [/* ... */],
});

// Async settlement — codespar_charge / codespar_pay return synchronously,
// but real settlement lands via webhook. Poll, or stream over SSE.
const settled = await session.paymentStatus(charge.tool_call_id);
await session.paymentStatusStream(charge.tool_call_id, {
  onUpdate: (env) => console.log(env.status), // pending → succeeded / failed / refunded
});

// Async KYC — codespar_kyc returns the inquiry id; the buyer finishes
// the hosted flow off-platform. Poll or stream the disposition.
const v = await session.verificationStatus(inquiryToolCallId);
await session.verificationStatusStream(inquiryToolCallId, {
  onUpdate: (env) => console.log(env.status), // pending → approved / rejected / review / expired
});

// Complete Loop — full commerce workflow (meta-tool driven)
import { loop } from "@codespar/sdk";

const result = await loop(session, {
  steps: [
    { tool: "codespar_charge", params: { amount: 150, currency: "BRL", method: "pix", buyer: { name, document: cpf } } },
    { tool: "codespar_invoice", params: (prev) => ({ rail: "nfe", company_id, payment_id: prev[0].data.id, /* ... */ }) },
    { tool: "codespar_ship", params: { action: "label", origin, destination, items } },
    { tool: "codespar_notify", params: { recipient: phone, message: "Order received." } },
  ],
  onStepComplete: (step, r) => console.log(`✓ ${step.tool}: ${r.duration}ms`),
});
```

### Meta-tools (F3.M2 router)

Beyond direct canonical-tool calls, the SDK exposes commerce-grade
**meta-tools** that route to the best provider per request, with
failover, idempotency, and per-tenant connection config:

| Meta-tool | What it does |
|---|---|
| `codespar_pay` | Outbound transfers / payouts (Asaas, Mercado Pago). |
| `codespar_charge` | INBOUND charges — buyer pays merchant. Pix BRL via Asaas / MP / iugu / Stone; card USD via Stripe. |
| `codespar_invoice` | Fiscal invoices. Defaults to NFS-e (services); pass `rail: "nfe"` for product NF-e via NFe.io. Also `nfci` (CFDI MX, Facturapi) and Factura AR (AFIP). |
| `codespar_notify` | Messaging — WhatsApp via Z-API / Twilio, SMS via Twilio, email via SendGrid. |
| `codespar_ship` | Melhor Envio with 3 rails (`action: "label" \| "quote" \| "track"`). |
| `codespar_crypto_pay` | Crypto payments via Coinbase Commerce + Bitso. |
| `codespar_kyc` | Identity / risk verification — Persona, Sift, Konduto, Truora. |
| `codespar_discover` | Find a tool for a free-form use case (`session.discover("...")`). |
| `codespar_manage_connections` | Surface the connection wizard (`session.connectionWizard({...})`). |

Use `session.execute("codespar_pay", { amount, currency, recipient })`
or the typed wrappers (`session.discover`, `session.connectionWizard`).
The router picks the best provider per call based on the tenant's
connections + cost/latency telemetry. See
[`codespar-enterprise/docs/operations/meta-tool-runbook.md`](../codespar-enterprise/docs/operations/meta-tool-runbook.md)
for the full operator guide.

## Framework Adapters

Each adapter exposes `getTools(session)` returning tools shaped for that framework. Same session, any framework — pick one or compose several.

```typescript
// Vercel AI SDK
import { getTools } from "@codespar/vercel";
const tools = getTools(session);
const result = await generateText({ model: openai("gpt-4o"), tools, prompt: "..." });

// Claude Agent SDK
import { getTools } from "@codespar/claude";
const tools = getTools(session);

// OpenAI Agents SDK
import { getTools, handleToolCall } from "@codespar/openai";
const tools = getTools(session);

// LangChain.js / LlamaIndex.TS / Mastra / CrewAI / AutoGen / CAMEL / Letta / Gemini
import { getTools } from "@codespar/langchain";  // or @codespar/llama-index, @codespar/mastra, etc.
const tools = getTools(session);

// MCP (Claude Desktop, Cursor, VS Code)
import { getMcpConfig } from "@codespar/mcp";
const { url, headers } = getMcpConfig(session);
```

## Multi-environment (dev/staging/prod)

Projects let you run independent environments — dev, staging, prod — inside a single org, each with its own connections, usage, and audit trail. Pin a client to a project with `new CodeSpar({ apiKey, projectId: "prj_..." })`, or override per call via `cs.create(userId, { projectId: "prj_..." })`. Session-level `projectId` wins over client-level; omit both and requests fall back to the org's default project.

When set, the SDK sends an `x-codespar-project` header on session creation and on all MCP transport calls. See [docs.codespar.dev/concepts/projects](https://docs.codespar.dev/concepts/projects) for the full managed-tier concept.

## Development

```bash
npm install
npm run build    # Build all packages
npm run test     # Run all tests
npm run typecheck # Type check all packages
```

## Need more?

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
