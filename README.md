# code\<spar\> SDK

Commerce infrastructure for AI agents. Payments, invoicing, shipping, notifications, and ERP across Latin America — one SDK.

## Packages

| Package | Description |
|---------|-------------|
| [`@codespar/sdk`](packages/core) | Sessions, managed auth, tool execution, Complete Loop orchestration |
| [`@codespar/vercel`](packages/vercel) | Vercel AI SDK adapter |
| [`@codespar/claude`](packages/claude) | Claude Agent SDK adapter |
| [`@codespar/openai`](packages/openai) | OpenAI Agents SDK adapter |
| [`@codespar/mcp`](packages/mcp) | MCP transport for Claude Desktop, Cursor, VS Code |

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
const loop = await session.loop({
  steps: [
    { server: "mcp-zoop", tool: "ZOOP_CREATE_CHARGE", params: { amount: 150, payment_type: "pix" } },
    { server: "mcp-nuvem-fiscal", tool: "NUVEMFISCAL_EMITIR_NFE", params: (prev) => ({ chargeId: prev[0].data }) },
    { server: "mcp-melhor-envio", tool: "MELHORENVIO_GENERATE_LABEL", params: { /* ... */ } },
    { server: "mcp-z-api", tool: "ZAPI_SEND_MESSAGE", params: { text: "Your order is on the way!" } },
    { server: "mcp-omie", tool: "OMIE_CREATE_ORDER", params: { /* ... */ } },
  ],
  onStepComplete: (step, result) => console.log(`✓ ${step.tool}: ${result.duration}ms`),
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

## Development

```bash
npm install
npm run build    # Build all packages
npm run test     # Run all tests
npm run typecheck # Type check all packages
```

## License

MIT — [codespar.dev](https://codespar.dev)
