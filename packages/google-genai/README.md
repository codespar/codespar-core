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

const cs = new CodeSpar({ apiKey: "csk_live_..." });
const session = await cs.sessions.create({ preset: "brazilian" });
const toolsConfig = await getToolsConfig(session);
```

## API

| Function | Description |
|----------|-------------|
| `getTools` | Convert all session tools to FunctionDeclaration array |
| `getToolsConfig` | Get full tools config for `getGenerativeModel()` |
| `toGeminiTool` | Convert a single tool |
| `handleFunctionCall` | Execute a function call via the session |

## License

MIT — [codespar.dev](https://codespar.dev)
