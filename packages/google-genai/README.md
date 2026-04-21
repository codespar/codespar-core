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

For production workloads with governance, audit trails, policy engines, self-hosted runtimes, and enterprise commerce primitives (mandates, escrow, payment routing), see **[CodeSpar Enterprise](https://codespar.dev/enterprise)**.

## License

MIT — [codespar.dev](https://codespar.dev)
