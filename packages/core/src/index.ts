/**
 * @codespar/sdk — Commerce SDK for AI agents
 *
 * Sessions, managed auth, Complete Loop orchestration
 * for Latin American commercial APIs.
 *
 * @example
 * ```ts
 * import { CodeSpar } from "@codespar/sdk";
 *
 * const cs = new CodeSpar({ apiKey: "ak_..." });
 * const session = await cs.create("user_123", { preset: "brazilian" });
 * const result = await session.send("Charge R$150 via Pix and issue the NF-e");
 * ```
 *
 * @packageDocumentation
 */

export type {
  CodeSparConfig,
  Session,
  SessionConfig,
  Tool,
  ToolResult,
  LoopConfig,
  LoopStep,
  LoopResult,
  AuthConfig,
  AuthResult,
  ServerConnection,
  SendResult,
} from "./types.js";

export { SessionConfigSchema } from "./types.js";

import type { CodeSparConfig, Session, SessionConfig } from "./types.js";
import { SessionConfigSchema } from "./types.js";
import { createSession } from "./session.js";

const DEFAULT_BASE_URL = "https://api.codespar.dev";

export class CodeSpar {
  private readonly config: Required<CodeSparConfig>;

  constructor(config: CodeSparConfig = {}) {
    this.config = {
      apiKey: config.apiKey || process.env.CODESPAR_API_KEY || "",
      baseUrl: config.baseUrl || process.env.CODESPAR_BASE_URL || DEFAULT_BASE_URL,
      managed: config.managed ?? true,
    };

    if (!this.config.apiKey) {
      throw new Error(
        "CodeSpar API key is required. Pass { apiKey: '...' } or set CODESPAR_API_KEY env var.\n" +
        "Get your key at https://dashboard.codespar.dev/settings?tab=api-keys"
      );
    }
  }

  /**
   * Create a new session for a user.
   *
   * @param userId - Unique user identifier
   * @param config - Session configuration (servers, preset, auth)
   * @returns A session with tools, execute, loop, and send methods
   *
   * @example
   * ```ts
   * const session = await cs.create("user_123", {
   *   preset: "brazilian",
   *   manageConnections: { waitForConnections: true },
   * });
   * ```
   */
  async create(userId: string, config: SessionConfig = {}): Promise<Session> {
    // Validate config
    SessionConfigSchema.parse(config);

    return createSession(userId, config, {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey,
      managed: this.config.managed,
    });
  }

  /**
   * Auth manager for programmatic OAuth flows.
   */
  get authManager() {
    const baseUrl = this.config.baseUrl;
    const apiKey = this.config.apiKey;

    return {
      /**
       * Get the OAuth connect URL for a provider.
       * Redirect the user to this URL to start the OAuth flow.
       */
      getConnectUrl(serverId: string, redirectUrl?: string): string {
        const params = new URLSearchParams({ serverId });
        if (redirectUrl) params.set("redirect", redirectUrl);
        return `${baseUrl}/v1/auth/connect?${params.toString()}&key=${apiKey}`;
      },

      /**
       * Check connection status for a server.
       */
      async getStatus(serverId: string): Promise<{ connected: boolean; expiresAt?: string }> {
        const res = await fetch(`${baseUrl}/v1/auth/status/${serverId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return { connected: false };
        return res.json() as Promise<{ connected: boolean; expiresAt?: string }>;
      },
    };
  }
}

export default CodeSpar;
