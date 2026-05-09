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
    async execute(toolName, params): Promise<ToolResult> {
      void params;
      const entry = responses[toolName];
      if (entry === undefined) {
        if (options.lenient) {
          return { success: true, data: {}, error: null, duration: 0, server: "", tool: toolName };
        }
        throw new Error(`fakeSession: no response registered for tool ${toolName}`);
      }
      const result = typeof entry === "function" ? await entry(params) : entry;
      return result;
    },
    // The remaining Session methods land in Task 5 — leave temporary `as any`-free
    // throws so the file still compiles. Replace these in Task 5 before that task's commit.
    async send() { throw new Error("fakeSession.send not implemented"); },
    async *sendStream() { throw new Error("fakeSession.sendStream not implemented"); },
    async proxyExecute() { throw new Error("fakeSession.proxyExecute not implemented"); },
    async authorize() { throw new Error("fakeSession.authorize not implemented"); },
    async connections() { return []; },
    async close() {},
    async discover() { throw new Error("fakeSession.discover not implemented"); },
    async connectionWizard() { throw new Error("fakeSession.connectionWizard not implemented"); },
    async charge() { throw new Error("fakeSession.charge not implemented"); },
    async ship() { throw new Error("fakeSession.ship not implemented"); },
    async paymentStatus() { throw new Error("fakeSession.paymentStatus not implemented"); },
    async paymentStatusStream() { throw new Error("fakeSession.paymentStatusStream not implemented"); },
    async verificationStatus() { throw new Error("fakeSession.verificationStatus not implemented"); },
    async verificationStatusStream() { throw new Error("fakeSession.verificationStatusStream not implemented"); },
  };
  return session;
}
