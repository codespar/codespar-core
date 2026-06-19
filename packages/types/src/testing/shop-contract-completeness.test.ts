/**
 * Contract-spec completeness review (named gate).
 *
 * Confirms the standalone `codespar_shop` contract spec
 * (docs/codespar-shop-contract.md) enumerates every action, input
 * field, output field, error code, status value, and cross-cutting
 * stance the contract requirements cover. This is the automated form of
 * the "a reviewer confirms each requirement has a section/table"
 * checklist — each entry below asserts the spec contains the literal
 * token a conforming consumer would search for.
 *
 * If this fails, the spec doc has drifted from the contract surface and
 * must be brought back into sync before merge.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// packages/types/src/testing → repo root → docs/
const SPEC_PATH = resolve(here, "../../../../docs/codespar-shop-contract.md");
const spec = readFileSync(SPEC_PATH, "utf8");

/** Assert every token appears in the spec; report any that are missing. */
function expectAllPresent(label: string, tokens: string[]): void {
  const missing = tokens.filter((t) => !spec.includes(t));
  expect(missing, `${label}: missing from contract spec`).toEqual([]);
}

describe("codespar_shop contract-spec completeness", () => {
  it("enumerates the closed action set (R1)", () => {
    expectAllPresent("actions", [
      "`search`",
      "`checkout`",
      "`checkout_status`",
      "closed",
      "`invalid_args`",
    ]);
  });

  it("documents every input field per action (R2)", () => {
    expectAllPresent("search inputs", ["`query`", "`limit`", "`merchant`"]);
    expectAllPresent("checkout inputs", [
      "`items`",
      "`url`",
      "items XOR url",
      "`consumer_id`",
      "`buyer`",
      "`address`",
      "`variant_id`",
      "`quantity`",
      "`seller`",
      "`cep`",
    ]);
    expectAllPresent("status inputs", ["`checkout_session_id`"]);
  });

  it("documents every output field + the ShopOffer/ShopVariant shapes (R3)", () => {
    expectAllPresent("offer/variant", [
      "`ShopOffer`",
      "`ShopVariant`",
      "`product_id`",
      "`sku_id`",
      "`price_minor`",
      "`currency`",
      "`available`",
      "`variants`",
    ]);
    expectAllPresent("status output", [
      "`total_minor`",
      "`pix_copia_e_cola`",
      "`order_status`",
      "`error`",
    ]);
    expectAllPresent("zero-result", ["`products: []`"]);
  });

  it("documents the state machine (R4)", () => {
    expectAllPresent("state machine", [
      "`in_progress`",
      "`ready_for_payment`",
      "`canceled`",
      "Poll-after-terminal",
      "no `expired` status today",
    ]);
  });

  it("enumerates the error taxonomy + channels (R5)", () => {
    expectAllPresent("errors", [
      "`invalid_args`",
      "`provider_error`",
      "`browser_worker_unconfigured`",
      "`browser_worker_failed`",
      "`browser_worker_checkout_failed`",
      "`browser_worker_meli_failed`",
      "`browser_worker_async_start_failed`",
      "`browser_worker_status_failed`",
      "`meli_url_required`",
      "`items_required`",
    ]);
    expect(spec).toMatch(/KYC.*NOT part of this contract/s);
  });

  it("records vtex_identity_required as net-new (R5a)", () => {
    expectAllPresent("vtex identity", ["`vtex_identity_required`", "net-new"]);
  });

  it("documents merchant stance, the enforced limit, and pagination (R6)", () => {
    expectAllPresent("merchant + limits", [
      "open string",
      "catch-all",
      "1..20",
      "enforce-clamped",
    ]);
    expect(spec).toMatch(/Pagination is deferred/);
  });

  it("records the unversioned-v0 + additive versioning stance (R8)", () => {
    expectAllPresent("versioning", [
      "Unversioned v0",
      "additive",
    ]);
  });

  it("includes the Tier 0/1/2 ↔ S1–S6 crosswalk with the non-normative statement (R9)", () => {
    expectAllPresent("crosswalk", [
      "Tier 0",
      "Tier 1",
      "Tier 2",
      "S1–S6",
      "crosswalk",
      "Neither vocabulary is normative",
      "`rail`",
    ]);
  });

  it("documents the capability token, redaction + abort obligations (R10/R16)", () => {
    expectAllPresent("obligations", [
      'capabilities: ["shop"]',
      "advisory",
      "redacted from logs",
      "non-authoritative",
      "session.shop(",
    ]);
  });
});
