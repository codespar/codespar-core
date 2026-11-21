// fakeSession v1 covers execute()-driven flows. send(), sendStream(),
// and channel mocking land when Layer 3 demos demand them.

import type { Session, ToolResult } from "@codespar/types";

export type { ToolResult };

export interface FakeSessionOptions {
  /** When true, unregistered tool names resolve to {success:true,data:{}} instead of throwing. */
  lenient?: boolean;
  /** Quem a sessao representa. Default `"user_fake"`. */
  userId?: string;
  /** Os servidores que ela alcanca. Default `[]`. */
  servers?: string[];
  /** Quando ela nasceu. Default uma data fixa, para o teste ser deterministico. */
  createdAt?: Date;
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
    userId: options.userId ?? "user_fake",
    servers: options.servers ?? [],
    // Data FIXA, nao `new Date()`: mock com relogio faz teste que passa hoje e
    // reprova amanha, e a snapshot de quem usa o kit muda sozinha.
    createdAt: options.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
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

    async ledger(args) {
      if (args.action === "balance") {
        return { account_id: args.account ?? "acc_fake", balances: [] };
      }
      if (args.action === "account") {
        return { id: "acc_fake", account_id: "acc_fake", alias: args.alias ?? null };
      }
      return { id: "txn_fake", status: "POSTED" };
    },

    async card(args) {
      const view = {
        id: "icrd_fake",
        issuer: "pomelo" as const,
        program: "pomelo_brl" as const,
        currency: "BRL" as const,
        status: "active" as const,
        issuer_status: "ACTIVE",
        last4: "4242",
        network: "mastercard" as const,
        mandate_id: "mnd_fake",
        consumer_id: "cons_fake",
        created_at: new Date(0).toISOString(),
        available_actions: ["freeze" as const, "cancel" as const],
      };
      if (args.action === "issue") {
        return {
          state: "issued" as const,
          issue_request_id: "cir_fake",
          issuer: view.issuer,
          program: view.program,
          selection: { provider_requested: args.provider ?? null, chosen_by: args.provider ? ("provider" as const) : ("currency" as const) },
          card: view,
          authorization_id: "caia_fake",
          authorization_active: true,
        };
      }
      if (args.action === "list") return { cards: [view] };
      if (args.action === "get") return { ...view, id: args.card_id };
      if (args.action === "freeze") return { ...view, id: args.card_id, status: "blocked" as const, issuer_status: "BLOCKED", available_actions: ["unfreeze" as const, "cancel" as const] };
      if (args.action === "cancel") return { ...view, id: args.card_id, status: "canceled" as const, issuer_status: "DISABLED", available_actions: [] };
      return { ...view, id: args.card_id };
    },

    async shop(args) {
      if (args.action === "search") {
        return { rail: "fake", products: [] };
      }
      if (args.action === "checkout") {
        return { checkout_session_id: "cks_fake", status: "in_progress" };
      }
      return { checkout_session_id: args.checkout_session_id, status: "in_progress" };
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
