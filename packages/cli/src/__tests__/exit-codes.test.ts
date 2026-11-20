/**
 * Exit codes of the outcome commands (Shop G3.1 data calls): 0 confirmed,
 * 10 pending, 20 refused, 30 failure, 40 uncertain. Only an opted-in command
 * uses them; every other command keeps exit 1 for any failure.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, exitCodeForDataCall, exitCodeForFailure, outcomeExitCodesOn, pendingOnPerson, resetExitPolicy, useOutcomeExitCodes } from "../exit-codes.js";

afterEach(() => resetExitPolicy());

const base = {
  proposal_id: "prp_AbCdEfGhIjKlMnOp",
  run_state: "ready",
  awaiting: null,
  offer: {} as never,
  quotation: { state: "valid", total_minor: 50, observed_at: "", valid_until: "" },
  authorization: { state: "needed", amount_max_minor: 50 },
  commitment: { state: "not_started" },
  payment: { state: "none" },
  confirmation: { state: "none" },
  actions: { execute: true, cancel: true, requote: false },
} as const;
const view = (over: Record<string, unknown>) => ({ ...base, ...over }) as never;

describe("exit codes of a data call's answer", () => {
  it("each outcome has its code, read from the four states apart", () => {
    expect(exitCodeForDataCall(view({ confirmation: { state: "confirmed", result_ref: "tdr_1" } }))).toBe(EXIT.ok);
    expect(exitCodeForDataCall(view({}))).toBe(EXIT.pending);
    expect(exitCodeForDataCall(view({ error: { code: "commitment_terms_changed" } }))).toBe(EXIT.refused);
    expect(exitCodeForDataCall(view({ commitment: { state: "failed" }, confirmation: { state: "failed" } }))).toBe(EXIT.failed);
    expect(exitCodeForDataCall(view({ commitment: { state: "uncertain" }, payment: { state: "debited" } }))).toBe(EXIT.uncertain);
  });
});

describe("exit codes of a failure", () => {
  it("off by default: nothing opted in", () => {
    expect(outcomeExitCodesOn()).toBe(false);
  });

  it("an API refusal (4xx) is 20; a server error is 30", () => {
    useOutcomeExitCodes({ effect: false });
    expect(exitCodeForFailure("api", 403)).toBe(EXIT.refused);
    expect(exitCodeForFailure("api", 409)).toBe(EXIT.refused);
    expect(exitCodeForFailure("api", 503)).toBe(EXIT.failed);
  });

  it("a timeout or a dropped connection is 30 on a read, 40 on an effect", () => {
    useOutcomeExitCodes({ effect: false });
    expect(exitCodeForFailure("timeout")).toBe(EXIT.failed);
    expect(exitCodeForFailure("network")).toBe(EXIT.failed);
    useOutcomeExitCodes({ effect: true });
    expect(exitCodeForFailure("timeout")).toBe(EXIT.uncertain);
    expect(exitCodeForFailure("network")).toBe(EXIT.uncertain);
  });
});

describe("a key asked to run a data call: pending on the person, with their protected action", () => {
  const refusal = (url?: string) =>
    Object.assign(new Error("person_required"), { code: "person_required", status: 403, body: { error: { code: "person_required", details: url ? { next_action: { kind: "person_authorization", url } } : {} } } });

  it("an opted-in command gets the url to print (and exits pending)", () => {
    useOutcomeExitCodes({ effect: true });
    expect(pendingOnPerson(refusal("https://codespar.dev/dashboard/shop/data-calls/prp_x"))).toBe("https://codespar.dev/dashboard/shop/data-calls/prp_x");
  });

  it("without the protected action, or outside an opted-in command, it is a plain refusal", () => {
    useOutcomeExitCodes({ effect: true });
    expect(pendingOnPerson(refusal())).toBeNull();
    resetExitPolicy();
    expect(pendingOnPerson(refusal("https://codespar.dev/dashboard/shop/data-calls/prp_x"))).toBeNull();
  });
});
