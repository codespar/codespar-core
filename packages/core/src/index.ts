/**
 * @codespar/sdk — Commerce SDK for AI agents
 *
 * Sessions, managed auth, Complete Loop orchestration for Latin American
 * commercial APIs.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 *
 * const cs = new CodeSpar({ apiKey: "csk_live_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 *
 * // One-shot natural language
 * const result = await session.send("Charge R$150 via Pix and issue the NF-e");
 *
 * // Or stream the agent's thinking + tool calls
 * for await (const event of session.sendStream("Charge R$150 via Pix")) {
 *   if (event.type === "tool_result") console.log(event.toolCall);
 *   if (event.type === "assistant_text") console.log(event.content);
 * }
 * ```
 *
 * @packageDocumentation
 */

export * from "@codespar/types";

export type {
  CodeSparConfig,
  SessionConfig,
  Tool,
  LoopConfig,
  LoopStep,
  LoopResult,
} from "./types.js";

export { SessionConfigSchema } from "./types.js";
export { loop } from "./loop.js";
export { tools, findTools } from "./tools.js";
export { CodesparApiError, TimeoutError } from "./errors.js";
export type { CodesparApiErrorOptions } from "./errors.js";
export {
  TOOL_RESULT_CODES,
  ToolResultCode,
  assertExhaustiveToolResult,
  isApprovalRequired,
  isMocksEngineError,
  isMocksExhausted,
  isPolicyDenied,
  isToolNotMocked,
} from "./tool-result-codes.js";
export type {
  ApprovalRequiredOutput,
  ApprovalRequiredToolCall,
  MocksEngineErrorOutput,
  MocksEngineErrorToolCall,
  MocksExhaustedOutput,
  MocksExhaustedToolCall,
  PolicyDeniedOutput,
  PolicyDeniedToolCall,
  ToolNotMockedOutput,
  ToolNotMockedToolCall,
  ToolResultOutcome,
} from "./tool-result-codes.js";

import type { CodeSparConfig, SessionConfig } from "./types.js";
import type { Session } from "@codespar/types";
import { SessionConfigSchema, PROJECT_ID_REGEX } from "./types.js";
import { createSession } from "./session.js";

const DEFAULT_BASE_URL = "https://api.codespar.dev";

export class CodeSpar {
  private readonly config: Required<CodeSparConfig>;

  constructor(config: CodeSparConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.CODESPAR_API_KEY || "",
      baseUrl: config.baseUrl || process.env.CODESPAR_BASE_URL || DEFAULT_BASE_URL,
      projectId: config.projectId || "",
    };

    if (!this.config.apiKey) {
      throw new Error(
        "CodeSpar API key is required. Pass { apiKey: '...' } or set CODESPAR_API_KEY env var.\n" +
          "Get your key at https://codespar.dev/dashboard/settings?tab=api-keys",
      );
    }

    // Wire-contract parity with the Python SDK
    // (`_async_client.py`: `api_key.startswith("csk_")`). Both staging
    // (`csk_`) and prod (`csk_live_`) keys share the `csk_` prefix.
    if (!this.config.apiKey.startsWith("csk_")) {
      throw new Error(
        "CodeSpar API key must start with 'csk_'.\n" +
          "Get your key at https://codespar.dev/dashboard/settings?tab=api-keys",
      );
    }

    // Validate the client-level projectId with the same wire format the
    // per-session Zod schema enforces, so both scoping paths reject the
    // same inputs (kept in sync with the Python client).
    if (this.config.projectId && !PROJECT_ID_REGEX.test(this.config.projectId)) {
      throw new Error(
        `CodeSpar projectId must match ${PROJECT_ID_REGEX.source} (e.g. 'prj_...').`,
      );
    }
  }

  /**
   * Create a new session for a user.
   *
   * @param userId - Unique user identifier
   * @param config - Session configuration (servers, preset, metadata)
   */
  async create(userId: string, config: SessionConfig = {}): Promise<Session> {
    SessionConfigSchema.parse(config);
    const projectId = config.projectId ?? this.config.projectId ?? undefined;
    return createSession(userId, config, {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      projectId: projectId || undefined,
    });
  }
}

export default CodeSpar;
