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
import { ApiClient, type ApiOperation, type ApiSuccess } from "@codespar/sdk";
import type { ApiFailure } from "./client.js";
import { ISSUER_ERROR_STATUSES, type ChargeView } from "./charge-rail.js";
import { createCodeSparClient, describeApiError } from "./client.js";

/** What the payer route answers, as the SDK's generated OpenAPI types it. */
export type SandboxPaidState = ApiSuccess<ApiOperation<"/v1/test/charges/{chargeId}/pay", "post">>;

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

/** Why the payer did not call the pay route: there was nothing a payer could have paid. */
export type PayerRefusal = { code: "no_payable_instrument" | "charge_issuer_error"; message: string };

export type GuardedPayResult = SandboxPayResult | { ok: false; refused: PayerRefusal };

/**
 * The sandbox payer as a PAYER: it reads the charge first and pays only an
 * instrument a person could have paid, a Pix or a boleto line the read calls
 * `payable`. A charge the issuer ended in error (`ERROR`) is refused as
 * `charge_issuer_error`, anything else unpayable as `no_payable_instrument`,
 * and in both cases the pay route is never called.
 *
 * The route itself settles whatever it is handed: a charge still
 * `PROCESSING`, and on staging on 2026-09-27 a charge the issuer ended in
 * `ERROR`, after which the read answers `CONFIRMED` (ent#1816,
 * OPEN_QUESTIONS §63). A payer that trusted it turned an issuance that failed
 * into a "settled" order no customer could have paid. No live payer can pay a
 * charge with no instrument, so neither does this one.
 */
export async function payIfPayable(api: ApiClient, chargeRef: string, amountMinor?: number): Promise<GuardedPayResult> {
  let view: ChargeView;
  try {
    view = await api.get("/v1/charges/{chargeId}", { path: { chargeId: chargeRef } });
  } catch (err) {
    return { ok: false, failure: describeApiError(err) };
  }
  if (ISSUER_ERROR_STATUSES.includes(view.status)) {
    return { ok: false, refused: { code: "charge_issuer_error", message: `the issuer ended charge ${chargeRef}'s registration in ${view.status}; there is no instrument to pay, so the pay route was not called` } };
  }
  if (!view.payable) {
    return { ok: false, refused: { code: "no_payable_instrument", message: `charge ${chargeRef} has no payable instrument (status ${view.status}, local ${view.local_status}); the pay route was not called` } };
  }
  return paySandboxCharge(api, chargeRef, amountMinor);
}
