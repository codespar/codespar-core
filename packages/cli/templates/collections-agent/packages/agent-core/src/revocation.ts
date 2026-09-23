/**
 * Section 4.7: the core asks a status source before `executing`. The
 * approval artifact alone is not enough, because it may predate a
 * revocation. The interface is the contract. Two implementations ship:
 * `api/mandate-status.ts` reads `GET /v1/mandates/{id}` and is what a run
 * with a test key gets; `stubs/mandate-status.ts` answers from the local
 * state.db and is what a run without a key (the CI, the scenarios, `rerun`)
 * gets, so revocation can be driven with no network.
 *
 * `unknown` is a status too: the source could not say. The engine treats it
 * as "do not execute" (`mandate_status_unavailable`), never as `active`.
 */
export type MandateStatus = "active" | "paused" | "revoked" | "expired";

export interface MandateStatusReport {
  mandate_id: string;
  status: MandateStatus | "unknown";
  /** True when the organization pressed the kill switch (`org pauseAll`). The API has no such read yet; only the stub can say it. */
  org_paused: boolean;
  checked_at: string;
  /** Which source answered, so the bundle says whether the check was real. */
  source: "stub" | "api";
  /** Why the status is `unknown`, for the trail. Never carries a response body. */
  detail?: string;
}

export interface MandateStatusSource {
  /** Must not throw for a read that failed: answer `unknown` and say why. A source that throws is still fail-closed at the gate. */
  check(mandateId: string): Promise<MandateStatusReport>;
}
