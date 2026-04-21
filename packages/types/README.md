# @codespar/types

Zero-dependency TypeScript package defining the shared session interface hierarchy for CodeSpar runtimes.

Any runtime that implements `SessionBase` — the managed CodeSpar backend, Anthropic Managed Agents, a self-hosted server, or a test double — is a first-class citizen in the SDK ecosystem. The contract is the only coupling between runtimes and the tools that run on top of them.

## Install

```bash
npm install @codespar/types
```

## Interfaces

### `SessionBase`

The minimal interface any runtime must implement.

```typescript
import type { SessionBase } from "@codespar/types";

interface SessionBase {
  readonly id: string;
  readonly status: "active" | "closed" | "error";

  execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult>;
  send(message: string): Promise<SendResult>;
  sendStream(message: string): AsyncIterable<StreamEvent>;
  connections(): Promise<BaseConnection[]>;
  close(): Promise<void>;
}
```

### `Session`

The codespar-specific extension of `SessionBase`, used when a session was created through the managed CodeSpar API.

```typescript
import type { Session } from "@codespar/types";

interface Session extends SessionBase {
  proxyExecute(request: ProxyRequest): Promise<ProxyResult>;
  authorize(serverId: string, config?: AuthConfig): Promise<AuthResult>;
  mcp?: {
    url: string;
    headers: Record<string, string>;
  };
}
```

### `isCodesparSession`

Type guard to narrow a `SessionBase` to `Session` when you need codespar-specific methods.

```typescript
import { isCodesparSession } from "@codespar/types";

function useSession(session: SessionBase) {
  if (isCodesparSession(session)) {
    // session is Session here — proxyExecute, authorize, mcp available
    const config = session.mcp;
  }
}
```

## Wire types

| Type | Description |
|------|-------------|
| `ToolResult` | Return value of `execute()` — `success`, `data`, `error`, `duration`, `server`, `tool` |
| `SendResult` | Return value of `send()` — `message`, `tool_calls`, `iterations` |
| `StreamEvent` | Union of events yielded by `sendStream()` — `user_message`, `assistant_text`, `tool_use`, `tool_result`, `done`, `error` |
| `BaseConnection` | Entry from `connections()` — `id`, `connected` |
| `ServerConnection` | Extended connection with name and provider metadata |
| `ProxyRequest` | Input to `proxyExecute()` — `server`, `endpoint`, `method`, `body`, `headers` |
| `ProxyResult` | Return value of `proxyExecute()` — `status`, `data`, `headers`, `duration`, `proxy_call_id` |
| `AuthConfig` | Input to `authorize()` — `redirectUrl` |
| `AuthResult` | Return value of `authorize()` — `authUrl`, `state` |

## Conformance testing

`@codespar/types` ships a `runContractSuite` helper under a `/testing` subpath export. It registers a standard Vitest/Jest test suite that exercises the five `SessionBase` methods against a live HTTP endpoint.

```typescript
// my-runtime.test.ts
import { runContractSuite } from "@codespar/types/testing";

// Skip unless the env vars are present
const apiKey = process.env["MY_RUNTIME_API_KEY"];
const baseUrl = process.env["MY_RUNTIME_BASE_URL"] ?? "http://localhost:3000";

if (apiKey) {
  runContractSuite(baseUrl, apiKey);
}
```

The suite validates:
- `execute()` calls a registered tool and returns a `ToolResult`
- `send()` returns a `SendResult` with a `message` field
- `sendStream()` yields well-typed `StreamEvent`s including a `done` event
- `connections()` returns entries with `id` and `connected` fields
- `close()` transitions `session.status` to `"closed"`

See [docs/custom-session-runtime.md](../../docs/custom-session-runtime.md) for a full implementation guide.

## License

MIT — [codespar.dev](https://codespar.dev)
