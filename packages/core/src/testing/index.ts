// fakeSession v1 covers execute()-driven flows. send(), sendStream(),
// and channel mocking land when Layer 3 demos demand them.

import type { Session, ToolResult } from "@codespar/types";

export type { ToolResult };

export interface FakeSessionOptions {
  /** When true, unregistered tool names resolve to {success:true,data:{}} instead of throwing. */
  lenient?: boolean;
}

type FakeSessionResponse =
  | ToolResult
  | ((input: Record<string, unknown>) => ToolResult | Promise<ToolResult>);

export function fakeSession(
  responses: Record<string, FakeSessionResponse> = {},
  options: FakeSessionOptions = {},
): Session {
  const session: Session = {
    id: "ses_fake",
    status: "active",
    mcp: { url: "https://example.invalid/mcp", headers: {} },

    async execute(toolName, params): Promise<ToolResult> {
      void params;
      const entry = responses[toolName];
      if (entry === undefined) {
        if (options.lenient) {
          return { success: true, data: {}, error: null, duration: 0, server: "", tool: toolName };
        }
        throw new Error(`fakeSession: no response registered for tool ${toolName}`);
      }
      return typeof entry === "function" ? await entry(params) : entry;
    },

    async send() {
      return { message: "", tool_calls: [], iterations: 0 };
    },

    async *sendStream() {
      // intentionally empty — fakeSession v1 does not synthesize stream events
    },

    async proxyExecute() {
      return { status: 200, data: null, headers: {}, duration: 0 };
    },

    async authorize() {
      return {
        linkToken: "tok_test",
        authorizeUrl: "https://provider.example.com/authorize",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },

    async connections() {
      return [];
    },

    async close() {
      // noop
    },

    async discover(useCase) {
      return { use_case: useCase, search_strategy: "empty", recommended: null, related: [], next_steps: [] };
    },

    async connectionWizard(opts) {
      return { action: opts.action ?? "list", connections: [], status: null, initiate: null };
    },

    async charge(args) {
      return { id: "chg_fake", status: "pending", amount: args.amount, currency: args.currency, method: args.method };
    },

    async ship(args) {
      return { id: "shp_fake", status: args.action === "track" ? "in_transit" : "created" };
    },

    async paymentStatus(toolCallId) {
      return { tool_call_id: toolCallId, payment_status: "pending", idempotency_key: null, original_status: "success", events: [] };
    },

    async paymentStatusStream(toolCallId) {
      return { tool_call_id: toolCallId, payment_status: "pending", idempotency_key: null, original_status: "success", events: [] };
    },

    async verificationStatus(toolCallId) {
      return { tool_call_id: toolCallId, verification_status: "pending", idempotency_key: null, original_status: "success", hosted_url: null, events: [] };
    },

    async verificationStatusStream(toolCallId) {
      return { tool_call_id: toolCallId, verification_status: "pending", idempotency_key: null, original_status: "success", hosted_url: null, events: [] };
    },
  };
  return session;
}
