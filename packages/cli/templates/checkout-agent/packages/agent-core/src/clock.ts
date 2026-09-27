/**
 * A clock pinned to an instant the caller chose, for a run whose outcome must
 * not depend on the hour it happens to execute at (the CI, a demo, a test).
 * `ExecutionEngine`, the stubs, the status gate and the loop all take a
 * `clock` dependency; this is the one the one-shot runner hands them when
 * `--now` or `CODESPAR_AGENT_NOW` is set. The scenario runner freezes its own
 * clock the same way.
 *
 * The clock advances one second per read so no two events share an instant,
 * which is what the scenario runner does too.
 */

export const FIXED_CLOCK_ENV = "CODESPAR_AGENT_NOW";

export class InvalidFixedClockError extends Error {
  constructor(value: string, source: string) {
    super(`${source} must be an ISO 8601 instant (e.g. 2026-09-23T14:00:00-03:00), got "${value}"`);
    this.name = "InvalidFixedClockError";
  }
}

/** A clock that starts at `iso` and ticks one second per read. Throws on a value `Date` cannot parse. */
export function fixedClock(iso: string, source = "--now"): () => Date {
  const start = new Date(iso);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso.trim()) || Number.isNaN(start.getTime())) throw new InvalidFixedClockError(iso, source);
  let current = start.getTime() - 1000;
  return () => {
    current += 1000;
    return new Date(current);
  };
}

/**
 * The clock a command runs with: the `--now` flag, else `CODESPAR_AGENT_NOW`
 * from the environment, else `undefined` (the wall clock, the caller's default).
 */
export function resolveFixedClock(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): (() => Date) | undefined {
  if (flag !== undefined) return fixedClock(flag, "--now");
  const fromEnv = env[FIXED_CLOCK_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fixedClock(fromEnv, FIXED_CLOCK_ENV);
  return undefined;
}
