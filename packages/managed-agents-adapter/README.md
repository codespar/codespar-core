# @codespar/managed-agents-adapter

Bridges the Anthropic Managed Agents API to the CodeSpar `SessionBase` interface, so tools built on `@codespar/sdk` run without modification against Managed Agents sessions.

> **Pre-GA note.** The Anthropic Managed Agents SDK is not yet generally available. This package defines its own `AgentRuntime` stub interface and will switch to the official `@anthropic-ai/managed-agents` import when the SDK reaches GA.

## Install

```bash
npm install @codespar/managed-agents-adapter @codespar/session-contract
```

## Usage

```typescript
import { createManagedAgentsSession } from "@codespar/managed-agents-adapter";
import { tools, loop } from "@codespar/sdk";

// runtime is any object satisfying AgentRuntime — your Managed Agents client
const session = await createManagedAgentsSession(runtime, {
  agentId: "agent_abc123",
  environmentId: "env_prod",
});

// Standard SDK free functions work unchanged
const available = await tools(session);
const result = await loop(session, { steps: [...] });
```

## Policy hook

A `PolicyHook` lets you intercept tool executions before they run. The hook receives the agent ID and tool name and returns a decision.

```typescript
import {
  createManagedAgentsSession,
  type PolicyHook,
} from "@codespar/managed-agents-adapter";

const policyHook: PolicyHook = {
  async evaluate(agentId, toolName) {
    if (toolName.startsWith("PIX_") && !isApproved(agentId)) {
      return { allowed: false };
    }
    if (toolName === "TRANSFER_FUNDS") {
      return { allowed: true, requiresApproval: true };
    }
    return { allowed: true };
  },
};

const session = await createManagedAgentsSession(runtime, config, { policyHook });
```

Policy evaluation runs on the original params **before** any `sanitizeParams` function is applied. This ordering is intentional — sanitization could strip fields (such as `amount`) that the policy uses to enforce fund-transfer caps.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `policyHook` | `PolicyHook` | — | Optional hook to approve or block tool executions |
| `sanitizeParams` | `(params) => params` | — | Transform params after policy evaluation, before the tool call is sent |
| `drainTimeoutMs` | `number` | `30000` | Milliseconds to wait for a tool result before throwing `DrainTimeoutError` |

## Errors

| Error | Thrown when |
|-------|-------------|
| `InvalidToolNameError` | Tool name contains characters outside `[a-zA-Z0-9_-]` |
| `PolicyViolationError` | `policyHook.evaluate` returns `{ allowed: false }` |
| `ApprovalRequiredError` | `policyHook.evaluate` returns `{ requiresApproval: true }` |
| `ConcurrentOperationError` | `execute`, `send`, or `sendStream` is called while another is in progress |
| `DrainTimeoutError` | The event stream does not yield the expected result within `drainTimeoutMs` |

**Do not auto-retry after `DrainTimeoutError` on commerce tools.** The remote operation (Pix transfer, NF-e issuance) may have already executed. Retrying risks a duplicate transaction.

## `AgentRuntime` interface

Until the Anthropic Managed Agents SDK reaches GA, this package defines the runtime interface itself:

```typescript
interface AgentRuntime {
  createSession(config: { agentId: string; environmentId: string }): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(sessionId: string): AsyncIterable<AgentEvent>;
  getStatus(sessionId: string): Promise<{ state: string }>;
}
```

Implement this interface against the Managed Agents SDK or any compatible backend. When the official package exports a stable `AgentRuntime`, replace this stub with the import from `@anthropic-ai/managed-agents`.

## License

MIT — [codespar.dev](https://codespar.dev)
