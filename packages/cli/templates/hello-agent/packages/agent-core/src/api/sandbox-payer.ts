/**
 * The sandbox PAYER: `POST /v1/test/charges/{chargeId}/pay` (alias
 * `POST /v1/charges/{chargeId}/sandbox/pay`), test environment only. It
 * plays the debtor: the charge goes through the same settlement path a
 * provider `charge-in` webhook takes, `commerce.charge.paid` fans out to the
 * project's triggers, and every record it leaves carries `simulated: true`
 * plus `settled_against: "sandbox_fixture"`. No money moves anywhere. A
 * live-environment key is refused with `sandbox_pay_not_permitted` before
 * anything is read. Since `@codespar/sdk@0.16.5` the route is in the SDK's
 * OpenAPI document, so this is the client's own typed call (same base URL,
 * key and project header as every other call); until 0.16.4 it was a plain
 * `fetch`, see docs/OPEN_QUESTIONS.md section 31c. The key is checked for
 * the `csk_test_` prefix before a client exists, like every other call.
 */
import { ApiClient } from "@codespar/sdk";
import type { ApiFailure } from "./client.js";
import { createCodeSparClient, describeApiError } from "./client.js";

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

/** Where the payer route lives when no client exists yet: the same three things `createCodeSparClient` takes. */
export interface SandboxPayerTarget {
  apiKey: string | undefined;
  baseUrl?: string | undefined;
  projectId?: string | undefined;
  timeoutMs?: number;
}

export async function paySandboxCharge(target: ApiClient | SandboxPayerTarget, chargeRef: string, amountMinor?: number): Promise<SandboxPayResult> {
  const api = target instanceof ApiClient ? target : createCodeSparClient(target);
  try {
    const state = await api.post("/v1/test/charges/{chargeId}/pay", {
      path: { chargeId: chargeRef },
      body: amountMinor !== undefined ? { amount_minor: amountMinor } : {},
    });
    return { ok: true, state };
  } catch (err) {
    return { ok: false, failure: describeApiError(err) };
  }
}
