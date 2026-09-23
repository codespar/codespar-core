/**
 * STUB, for runs without a key: the CI, the scenarios and `rerun`, where
 * there is no network. Answers the section 4.7 status check from the local
 * state.db, so a scenario can revoke or pause a mandate mid-run
 * (`before_decision`, `before_execute` in the scenario packs) and the core
 * reacts exactly as it does against the API. Behind the same
 * `MandateStatusSource` interface as `api/mandate-status.ts`, which is what
 * a run with a test key gets instead; this file is never consulted on that
 * path.
 *
 * It also holds the organization kill switch (`pauseAll`), which the API
 * does not expose yet, so `org_paused` can be exercised locally.
 */
import type { MandateStatusSource, MandateStatus, MandateStatusReport } from "../revocation.js";
import type { StateStore } from "../state/store.js";

export const STUB_ORG_ID = "org_local_stub";

export class LocalMandateStatusStub implements MandateStatusSource {
  constructor(
    private readonly store: StateStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async check(mandateId: string): Promise<MandateStatusReport> {
    const row = this.store.stubMandateStatus(mandateId);
    return {
      mandate_id: mandateId,
      status: (row?.status as MandateStatus | undefined) ?? "active",
      org_paused: this.store.stubOrgPaused(STUB_ORG_ID),
      checked_at: this.clock().toISOString(),
      source: "stub",
    };
  }

  /** `codespar mandate revoke <id>`, locally. */
  revoke(mandateId: string, reason = "revoked by operator"): void {
    this.store.stubSetMandateStatus(mandateId, "revoked", reason, this.clock().toISOString());
  }

  pause(mandateId: string, reason = "paused by operator"): void {
    this.store.stubSetMandateStatus(mandateId, "paused", reason, this.clock().toISOString());
  }

  resume(mandateId: string): void {
    this.store.stubSetMandateStatus(mandateId, "active", null, this.clock().toISOString());
  }

  /** The organization kill switch, locally: the API has no `org pauseAll` yet. */
  pauseAll(): void {
    this.store.stubSetOrgPaused(STUB_ORG_ID, true, this.clock().toISOString());
  }

  resumeAll(): void {
    this.store.stubSetOrgPaused(STUB_ORG_ID, false, this.clock().toISOString());
  }
}
