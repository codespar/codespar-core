/**
 * @codespar/sdk — Commerce SDK for AI agents
 *
 * Sessions, managed auth, Complete Loop orchestration for Latin American
 * commercial APIs. Talks to api.codespar.dev — see the backend at
 * codespar/codespar-enterprise (packages/api) for the wire contract.
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

import type { CodeSparConfig, SessionConfig } from "./types.js";
import type { Session } from "@codespar/types";
import { SessionConfigSchema } from "./types.js";
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
