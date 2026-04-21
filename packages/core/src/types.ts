import { z } from "zod";
import type { ToolResult } from "@codespar/types";

/* ── Configuration ─────────────────────────────────────────────── */

export interface CodeSparConfig {
  /** API key for managed mode. Obtain from dashboard.codespar.dev */
  apiKey?: string;
  /** Base URL for CodeSpar API. Defaults to https://api.codespar.dev */
  baseUrl?: string;
  /** Optional project scope. Defaults to the org's default project when omitted. */
  projectId?: string;
}

/* ── Session config (SDK-level, not the wire contract) ──────────── */

export interface SessionConfig {
  /** MCP servers to connect, by id (e.g. "zoop", "nuvem-fiscal") */
  servers?: string[];
  /** Preset configurations. "brazilian" enables BR commerce servers. */
  preset?: "brazilian" | "mexican" | "argentinian" | "colombian" | "all";
  /** Connection management options */
  manageConnections?: {
    /** Block until all servers are connected */
    waitForConnections?: boolean;
    /** Timeout in ms for connection wait. Default: 30000 */
    timeout?: number;
  };
  /** Metadata attached to every tool call in this session */
  metadata?: Record<string, string>;
  /** Optional project scope. Defaults to the org's default project when omitted. */
  projectId?: string;
}

/* ── Tools ────────────────────────────────────────────────────── */

export interface Tool {
  /** Tool name (e.g. "codespar_pay") */
  name: string;
  /** Human-readable description shown to LLMs */
  description: string;
  /** JSON Schema for tool inputs */
  input_schema: Record<string, unknown>;
  /** Server that provides this tool (for routing/billing). May be "codespar" for meta-tools. */
  server: string;
}

/* ── Complete Loop ────────────────────────────────────────────── */

export interface LoopStep {
  /** Tool name to execute */
  tool: string;
  /** Tool parameters */
  params: Record<string, unknown> | ((prevResults: ToolResult[]) => Record<string, unknown>);
  /** Optional: skip this step if condition returns false */
  when?: (prevResults: ToolResult[]) => boolean;
}

export interface LoopConfig {
  /** Steps to execute in order */
  steps: LoopStep[];
  /** Called after each step completes */
  onStepComplete?: (step: LoopStep, result: ToolResult, index: number) => void;
  /** Called if a step fails */
  onStepError?: (step: LoopStep, error: Error, index: number) => void;
  /** Retry policy for failed steps */
  retryPolicy?: {
    maxRetries?: number;
    backoff?: "linear" | "exponential";
    baseDelay?: number;
  };
  /** Abort all remaining steps on first failure. Default: true */
  abortOnError?: boolean;
}

export interface LoopResult {
  success: boolean;
  /** Results from each step, in order */
  results: ToolResult[];
  /** Total execution time in ms */
  duration: number;
  /** Number of steps completed */
  completedSteps: number;
  /** Total steps attempted */
  totalSteps: number;
}

/* ── Validation schemas ───────────────────────────────────────── */

export const SessionConfigSchema = z.object({
  servers: z.array(z.string()).optional(),
  preset: z.enum(["brazilian", "mexican", "argentinian", "colombian", "all"]).optional(),
  manageConnections: z
    .object({
      waitForConnections: z.boolean().optional(),
      timeout: z.number().optional(),
    })
    .optional(),
  metadata: z.record(z.string()).optional(),
  projectId: z.string().regex(/^prj_[A-Za-z0-9]{16}$/).optional(),
});
