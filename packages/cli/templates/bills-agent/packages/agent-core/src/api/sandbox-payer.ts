/**
 * The sandbox PAYER: `POST /v1/test/charges/{chargeId}/pay` (alias
 * `POST /v1/charges/{chargeId}/sandbox/pay`), test environment only. It
 * plays the debtor: the charge goes through the same settlement path a
 * provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the
 * project's triggers, and every record it leaves carries `simulated: true`
 * plus `settled_against: "sandbox_fixture"`. No money moves anywhere. A
 * live-environment key is refused with `sandbox_pay_not_permitted` before
 * anything is read. The route is not in the SDK's typed operations yet
 * (merged 2026-09-23), so it is called by path.
 */
import type { ApiClient } from "@codespar/sdk";
import { describeApiError, type ApiFailure } from "./client.js";

export interface SandboxPaidState {
  charge_id: string;
  status: "paid";
  local_status: string;
  currency: string;
  quoted_minor: number;
  paid_minor: number;
  payment: "full" | "partial" | "over";
  paid_via: string;
  wallet_id: string;
  ledger_entry_id: string | null;
  event: { id: string; type: string } | null;
  simulated: boolean;
  settled_against: string | null;
  money_moved: false;
  idempotent_replay: boolean;
}

export type SandboxPayResult = { ok: true; state: SandboxPaidState } | { ok: false; failure: ApiFailure };

export async function paySandboxCharge(api: ApiClient, chargeRef: string, amountMinor?: number): Promise<SandboxPayResult> {
  try {
    const state = (await api.request("post", "/v1/test/charges/{chargeId}/pay" as never, {
      path: { chargeId: chargeRef },
      body: amountMinor !== undefined ? { amount_minor: amountMinor } : {},
    } as never)) as SandboxPaidState;
    return { ok: true, state };
  } catch (err) {
    return { ok: false, failure: describeApiError(err) };
  }
}
