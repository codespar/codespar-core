# @codespar/google-genai

Google Gemini/GenAI adapter for CodeSpar — convert session tools to Gemini FunctionDeclaration format.

## Install

```bash
npm install @codespar/google-genai @codespar/sdk
```

## Usage

```ts
import { CodeSpar } from "@codespar/sdk";
import { getToolsConfig } from "@codespar/google-genai";

const cs = new CodeSpar({ apiKey: process.env.CODESPAR_API_KEY! });
const session = await cs.create("user_123", { preset: "brazilian" });
const toolsConfig = await getToolsConfig(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to FunctionDeclaration array |
| `getToolsConfig` | Get full tools config for `getGenerativeModel()` |
| `toGeminiTool` | Convert a single tool |
| `handleFunctionCall` | Execute a function call via the session |

## Need more?

Need governance, budget limits, and audit trails for agent payments? **[CodeSpar Enterprise](https://codespar.dev/enterprise)** adds policy engine, payment routing, and compliance templates on top of these MCP servers.

## License

MIT — [codespar.dev](https://codespar.dev)
