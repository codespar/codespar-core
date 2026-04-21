import type { SessionBase, ToolResult } from "@codespar/types";
import type { LoopConfig, LoopResult } from "./types.js";

export async function loop(session: SessionBase, config: LoopConfig): Promise<LoopResult> {
  const start = Date.now();
  const results: ToolResult[] = [];
  const maxRetries = config.retryPolicy?.maxRetries ?? 0;
  const abortOnError = config.abortOnError ?? true;

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i]!;
    if (step.when && !step.when(results)) continue;

    const params =
      typeof step.params === "function" ? step.params(results) : step.params;

    let lastError: Error | null = null;
    let result: ToolResult | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await session.execute(step.tool, params);
        if (result.success) {
          lastError = null;
          break;
        }
        lastError = new Error(result.error || "Tool execution failed");
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempt < maxRetries) {
        const baseDelay = config.retryPolicy?.baseDelay ?? 1000;
        const delay =
          config.retryPolicy?.backoff === "exponential"
            ? baseDelay * Math.pow(2, attempt)
            : baseDelay * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (lastError || !result?.success) {
      if (config.onStepError) {
        config.onStepError(step, lastError || new Error("Unknown error"), i);
      }
      if (result) results.push(result);
      if (abortOnError) {
        return {
          success: false,
          results,
          duration: Date.now() - start,
          completedSteps: results.filter((r) => r.success).length,
          totalSteps: config.steps.length,
        };
      }
      continue;
    }

    results.push(result);
    if (config.onStepComplete) {
      config.onStepComplete(step, result, i);
    }
  }

  return {
    success: results.every((r) => r.success),
    results,
    duration: Date.now() - start,
    completedSteps: results.filter((r) => r.success).length,
    totalSteps: config.steps.length,
  };
}
