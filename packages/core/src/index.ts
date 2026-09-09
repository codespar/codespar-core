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
  CallOptions,
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
export { ApiClient, createApiClient } from "./api/client.js";
export type { ApiClientConfig } from "./api/client.js";
export type {
  ApiMethod,
  ApiOperation,
  ApiOperationRef,
  ApiPath,
  ApiPaths,
  ApiPathsFor,
  ApiRequestBody,
  ApiRequestOptions,
  ApiResponse,
  ApiSuccess,
} from "./api/types.js";
export { API_OPERATIONS } from "./generated/operations.js";
export type { components as ApiComponents } from "./generated/openapi.js";
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

import type { CodeSparConfig, SessionConfig, CallOptions } from "./types.js";
import type { Session } from "@codespar/types";
import { SessionConfigSchema, PROJECT_ID_REGEX } from "./types.js";
import { createSession } from "./session.js";
import { ApiClient } from "./api/client.js";
import { validateTimeout } from "./internal/fetch.js";

const DEFAULT_BASE_URL = "https://api.codespar.dev";

export class CodeSpar {
  private readonly config: Required<CodeSparConfig>;

  /**
   * Typed REST client over every operation of the served OpenAPI
   * document, generated from `openapi-snapshot.json`. Same credentials,
   * base URL, project scope and default timeout as this client.
   *
   * @example
   * ```ts
   * const wallet = await cs.api.get("/v1/wallets/{id}", { path: { id: "wal_example" } });
   * ```
   */
  readonly api: ApiClient;

  constructor(config: CodeSparConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.CODESPAR_API_KEY || "",
      baseUrl: config.baseUrl || process.env.CODESPAR_BASE_URL || DEFAULT_BASE_URL,
      projectId: config.projectId || "",
      timeout: config.timeout ?? 60000,
    };

    // Fail fast at construction — a misconfigured default timeout must
    // not produce a live-but-broken client that only fails on first use.
    validateTimeout(this.config.timeout);

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

    this.api = new ApiClient({
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      projectId: this.config.projectId || undefined,
      timeout: this.config.timeout,
    });
  }

  /**
   * Create a new session for a user.
   *
   * @param userId - Unique user identifier
   * @param config - Session configuration (servers, preset, metadata)
   * @param opts   - Per-call timeout/abort for the POST /v1/sessions
   *                 request itself; overrides the client default
   *                 (parity with the Python client's create(timeout=)).
   */
  async create(
    userId: string,
    config: SessionConfig = {},
    opts?: CallOptions,
  ): Promise<Session> {
    SessionConfigSchema.parse(config);
    const projectId = config.projectId ?? this.config.projectId ?? undefined;
    return createSession(userId, config, {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      projectId: projectId || undefined,
      timeout: this.config.timeout,
    }, opts);
  }
}

export default CodeSpar;
