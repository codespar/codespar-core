# Implementing a custom session runtime

The `@codespar/sdk` free functions (`tools`, `findTools`, `loop`) and all framework adapters accept any object that implements `SessionBase` from `@codespar/types`. This guide walks through building, testing, and shipping a custom session runtime.

## When you'd do this

- You're wrapping an AI provider that has its own session/thread concept (Anthropic Managed Agents, OpenAI Assistants, a self-hosted LLM server).
- You're building an in-process test double that doesn't hit the network.
- You want to run the CodeSpar SDK toolchain against your own backend.

The managed CodeSpar runtime is still the simplest path for production. Custom runtimes make sense when you already have an execution environment and want the SDK tooling on top.

## The interface

```typescript
import type { SessionBase, ToolResult, SendResult, StreamEvent, BaseConnection } from "@codespar/types";

class MySession implements SessionBase {
  readonly id: string;
  readonly status: "active" | "closed" | "error";

  async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> { ... }
  async send(message: string): Promise<SendResult> { ... }
  async *sendStream(message: string): AsyncIterable<StreamEvent> { ... }
  async connections(): Promise<BaseConnection[]> { ... }
  async close(): Promise<void> { ... }
}
```

TypeScript will tell you at compile time if anything is missing or mistyped. You don't need to extend a base class or register anywhere — duck typing is enough.

## Implementing each method

### `execute`

Called when a framework or user code wants to run a specific named tool. Your implementation should:
- Route the tool name to the correct downstream call.
- Return a `ToolResult` with `success`, `data`, `error`, `duration`, `server`, and `tool`.

```typescript
async execute(toolName: string, params: Record<string, unknown>): Promise<ToolResult> {
  const start = Date.now();
  try {
    const data = await this.client.runTool(toolName, params);
    return {
      success: true,
      data,
      error: null,
      duration: Date.now() - start,
      server: this.serverName,
      tool: toolName,
    };
  } catch (err) {
    return {
      success: false,
      data: null,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
      server: this.serverName,
      tool: toolName,
    };
  }
}
```

### `send`

Natural language message; the runtime resolves it to zero or more tool calls and a final message.

```typescript
async send(message: string): Promise<SendResult> {
  const response = await this.client.sendMessage(message);
  return {
    message: response.finalText,
    tool_calls: response.toolCalls ?? [],
    iterations: response.iterations ?? 1,
  };
}
```

### `sendStream`

Streaming variant. Yield a sequence of `StreamEvent` objects ending with a `done` event.

```typescript
async *sendStream(message: string): AsyncIterable<StreamEvent> {
  for await (const chunk of this.client.streamMessage(message)) {
    if (chunk.type === "text") {
      yield { type: "assistant_text", content: chunk.text, iteration: chunk.iteration };
    } else if (chunk.type === "tool_use") {
      yield { type: "tool_use", id: chunk.id, name: chunk.name, input: chunk.input };
    } else if (chunk.type === "done") {
      yield { type: "done", result: chunk.result };
      return;
    }
  }
}
```

### `connections`

Returns the connected servers or channels. For runtimes with a single backend, returning one entry is fine.

```typescript
async connections(): Promise<BaseConnection[]> {
  return [{ id: this.sessionId, connected: this.status === "active" }];
}
```

### `close`

Mark the session as closed and release any held resources. `status` must reflect the new state after this returns.

```typescript
async close(): Promise<void> {
  await this.client.endSession(this.sessionId);
  this._status = "closed";
}
```

## Exposing `tools` for free function support

The `tools(session)` free function in `@codespar/sdk` uses duck typing: if the session object has an internal `tools()` method, it calls it; otherwise it returns `[]`. If your runtime has a tool catalog, expose it:

```typescript
class MySession implements SessionBase {
  // Not part of SessionBase — picked up by duck-typing in tools() free function
  async tools(): Promise<Tool[]> {
    return this.client.listTools();
  }
}
```

This lets callers use `tools(session)` and `findTools(session, query)` without knowing the runtime type.

## Testing with `runContractSuite`

`@codespar/types` ships a conformance suite under `/testing`. It runs five standard Vitest/Jest tests against a live HTTP endpoint that creates and operates a session.

```typescript
// my-runtime-contract.test.ts
import { runContractSuite } from "@codespar/types/testing";

const apiKey = process.env["MY_API_KEY"];
const baseUrl = process.env["MY_BASE_URL"] ?? "http://localhost:3000";

if (apiKey) {
  runContractSuite(baseUrl, apiKey);
}
```

The suite expects a `POST /sessions` endpoint that accepts `{ apiKey }` and returns `{ id }`. It then calls `execute`, `send`, `sendStream`, `connections`, and `close` on the resulting session and asserts the shapes match the contract types.

Run it against your staging server before shipping:

```bash
MY_API_KEY=sk_test_... MY_BASE_URL=https://staging.my-runtime.example vitest run
```

The suite skips automatically when `MY_API_KEY` is not set, so it's safe to include in your main test run without breaking local development.

## Narrowing to `Session`

If your runtime also implements the codespar-specific extensions (`proxyExecute`, `authorize`, `mcp`), implement the `Session` interface instead. You can then use `isCodesparSession` to offer the additional capabilities where available:

```typescript
import { isCodesparSession } from "@codespar/types";
import { getMcpConfig } from "@codespar/mcp";

function configureMcp(session: SessionBase) {
  if (!isCodesparSession(session)) {
    throw new Error("MCP transport requires a codespar-managed session");
  }
  return getMcpConfig(session);
}
```

## Reference implementation

`@codespar/managed-agents-adapter` is a complete reference implementation of `SessionBase` against the Anthropic Managed Agents API. It covers:

- Mutex to prevent concurrent operations
- Tool name injection guard
- `PolicyHook` interface for pre-execution policy checks
- `sanitizeParams` for post-policy parameter transformation
- `DrainTimeoutError` for unresponsive streams

Source: [`packages/managed-agents-adapter/src/session.ts`](../packages/managed-agents-adapter/src/session.ts)
