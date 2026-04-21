# code\<spar\> SDK

Commerce infrastructure for AI agents. Payments, invoicing, shipping, notifications, and ERP across Latin America — one SDK.

## Packages

| Package | Description |
|---------|-------------|
| [`@codespar/sdk`](packages/core) | Sessions, managed auth, tool execution, Complete Loop orchestration |
| [`@codespar/types`](packages/types) | Zero-dependency `SessionBase`/`Session` interface hierarchy and conformance test suite |
| [`@codespar/managed-agents-adapter`](packages/managed-agents-adapter) | Anthropic Managed Agents adapter — runs `SessionBase` tools against Managed Agents sessions |
| [`@codespar/vercel`](packages/vercel) | Vercel AI SDK adapter |
| [`@codespar/claude`](packages/claude) | Claude Agent SDK adapter |
| [`@codespar/openai`](packages/openai) | OpenAI Agents SDK adapter |
| [`@codespar/mcp`](packages/mcp) | MCP transport for Claude Desktop, Cursor, VS Code |
| [`@codespar/cli`](packages/cli) | Command-line interface — auth, execute, sessions, scaffolding |

## Quick Start

```bash
npm install @codespar/sdk
```

```typescript
import { CodeSpar } from "@codespar/sdk";

const cs = new CodeSpar({ apiKey: "ak_..." });

// Create a session with Brazilian commerce servers
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
const charge = await session.execute("ZOOP_CREATE_CHARGE", {
  amount: 150.0,
  payment_type: "pix",
});

// Complete Loop — full commerce workflow
import { loop } from "@codespar/sdk";

const result = await loop(session, {
  steps: [
    { server: "mcp-zoop", tool: "ZOOP_CREATE_CHARGE", params: { amount: 150, payment_type: "pix" } },
    { server: "mcp-nuvem-fiscal", tool: "NUVEMFISCAL_EMITIR_NFE", params: (prev) => ({ chargeId: prev[0].data }) },
    { server: "mcp-melhor-envio", tool: "MELHORENVIO_GENERATE_LABEL", params: { /* ... */ } },
    { server: "mcp-z-api", tool: "ZAPI_SEND_MESSAGE", params: { text: "Your order is on the way!" } },
    { server: "mcp-omie", tool: "OMIE_CREATE_ORDER", params: { /* ... */ } },
  ],
  onStepComplete: (step, r) => console.log(`✓ ${step.tool}: ${r.duration}ms`),
});
```

## Framework Adapters

```typescript
// Vercel AI SDK
import { getTools } from "@codespar/vercel";
const tools = getTools(session);
const result = await generateText({ model: openai("gpt-4o"), tools, prompt: "..." });

// Claude
import { getTools } from "@codespar/claude";
const tools = getTools(session);

// OpenAI
import { getTools, handleToolCall } from "@codespar/openai";
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
