export interface PolicyDecision {
  allowed: boolean;
  requiresApproval?: boolean;
}

export class InvalidToolNameError extends Error {
  readonly toolName: string;
  constructor(toolName: string) {
    super(
      `Invalid tool name "${toolName}" — must match /^[a-zA-Z0-9_-]+$/ ` +
        "(whitespace or control characters could inject instructions into the Managed Agents payload)",
    );
    this.name = "InvalidToolNameError";
    this.toolName = toolName;
  }
}

export class PolicyViolationError extends Error {
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super("Tool execution rejected by policy");
    this.name = "PolicyViolationError";
    this.decision = decision;
  }
}

export class ApprovalRequiredError extends Error {
  readonly decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super("Tool execution requires human approval before proceeding");
    this.name = "ApprovalRequiredError";
    this.decision = decision;
  }
}

export class ConcurrentOperationError extends Error {
  constructor() {
    super("session already has an operation in progress");
    this.name = "ConcurrentOperationError";
  }
}

/**
 * Thrown when the Managed Agents event stream does not produce the expected
 * result within the configured drain timeout.
 *
 * Callers must NOT automatically retry commerce tools (Pix transfers, NF-e
 * issuance, or any other financial operation) after receiving this error.
 * The remote operation may have already executed — retrying risks a
 * duplicate transaction.
 */
export class DrainTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(
      `Agent stream drain timed out after ${timeoutMs}ms — do not retry commerce tools; ` +
        "the remote operation may have already executed",
    );
    this.name = "DrainTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when an operation is attempted on a session that has been
 * closed — or close() was requested while the operation was still in
 * a pre-dispatch phase (e.g. policy evaluation). Prevents dispatching
 * a (possibly non-idempotent) commerce tool after terminal cleanup.
 */
export class SessionClosedError extends Error {
  constructor() {
    super("session is closed — operation not dispatched");
    this.name = "SessionClosedError";
  }
}
