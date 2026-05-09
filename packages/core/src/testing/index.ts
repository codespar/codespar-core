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
  // Implementation lands in Tasks 2-5.
  void responses;
  void options;
  throw new Error("fakeSession: not yet implemented");
}
