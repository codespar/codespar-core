/**
 * Exit codes for the commands whose answer is an outcome a script branches
 * on (Shop G3.1 data calls first; the store commands of G2.1 reuse them).
 * Agreed across the core fronts on 07/11:
 *
 *   0   ok: the result is confirmed
 *   10  pending: the person or a next step is needed (a draft waits to be run)
 *   20  refused by the API with a code (person_required, 404, 409, terms changed)
 *   30  failure (5xx, or a network error on a READ)
 *   40  uncertain: an effect may have happened (sent, outcome not known yet)
 *   1   the CLI's own usage or configuration error
 *
 * Every other command keeps exit 1 for any failure: a command opts in, so
 * a script that already branches on 1 never sees its meaning change.
 */
import { dataCallOutcome, nextActionOfError, type DataCall } from "@codespar/sdk";

export const EXIT = { ok: 0, pending: 10, refused: 20, failed: 30, uncertain: 40, usage: 1 } as const;

interface Policy {
  /** Whether the running command uses these codes. */
  on: boolean;
  /** Whether the command asks for an effect (a timeout there is uncertain, not a failure). */
  effect: boolean;
}

const policy: Policy = { on: false, effect: false };

/** Opt the running command in. `effect`: it may cause something at the provider. */
export function useOutcomeExitCodes(opts: { effect: boolean }): void {
  policy.on = true;
  policy.effect = opts.effect;
}

export function outcomeExitCodesOn(): boolean {
  return policy.on;
}

/** The code of a data call's answer, from its four states. */
export function exitCodeForDataCall(view: DataCall): number {
  switch (dataCallOutcome(view)) {
    case "succeeded":
      return EXIT.ok;
    case "pending":
      return EXIT.pending;
    case "refused":
      return EXIT.refused;
    case "failed":
      return EXIT.failed;
    case "uncertain":
      return EXIT.uncertain;
  }
}

/**
 * A refusal that hands the person's protected action (criterion 5: a key asked to run a data call): the step is
 * pending on the person, not refused. Returns the url to print, or null.
 */
export function pendingOnPerson(err: unknown): string | null {
  if (!policy.on || (err as { code?: unknown } | null)?.code !== "person_required") return null;
  return nextActionOfError(err)?.url ?? null;
}

/** The code of a failure of an opted-in command: the API's refusal, a server error, the network or a timeout. */
export function exitCodeForFailure(kind: "api" | "timeout" | "network", status?: number): number {
  if (kind === "api" && status !== undefined && status >= 400 && status < 500) return EXIT.refused;
  if ((kind === "timeout" || kind === "network") && policy.effect) return EXIT.uncertain;
  return EXIT.failed;
}

/** For tests: back to the default policy. */
export function resetExitPolicy(): void {
  policy.on = false;
  policy.effect = false;
}
