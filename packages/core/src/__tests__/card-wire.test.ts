/**
 * The card types published in `@codespar/types` are hand-written (that
 * package has no dependencies), so nothing there may drift from the served
 * contract. These assertions bind each wire shape to the type generated
 * from the OpenAPI document: a change on either side fails `tsc` here.
 * (The vitest body is a runtime no-op; `npm run typecheck` is the check.)
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  CardFunding,
  CardPaymentToken,
  CardProgramSettlement,
  CardReadiness,
  CardRequirementKind,
  CardView,
} from "@codespar/types";
import type { paths } from "../generated/openapi.js";

type IssueOk = paths["/v1/cards"]["post"]["responses"][200]["content"]["application/json"];
type WireCard = IssueOk["card"];
type WireProgram =
  paths["/v1/cards/programs"]["get"]["responses"][200]["content"]["application/json"]["programs"][number];
type WireReadiness = paths["/v1/cards/readiness"]["get"]["responses"][200]["content"]["application/json"];
type WireRequirement = WireReadiness["programs"][number]["requirements"][number];

describe("card types == the served card schema", () => {
  it("funding, settlement and payment_token are the generated shapes", () => {
    expectTypeOf<CardFunding>().toEqualTypeOf<NonNullable<WireCard["funding"]>>();
    expectTypeOf<CardFunding>().toEqualTypeOf<NonNullable<WireProgram["funding"]>>();
    expectTypeOf<CardProgramSettlement>().toEqualTypeOf<NonNullable<WireProgram["settlement"]>>();
    expectTypeOf<CardPaymentToken>().toEqualTypeOf<NonNullable<WireCard["payment_token"]>>();
  });

  it("the card view's identity, status and network vocabularies", () => {
    expectTypeOf<CardView["issuer"]>().toEqualTypeOf<WireCard["issuer"]>();
    expectTypeOf<CardView["program"]>().toEqualTypeOf<WireCard["program"]>();
    expectTypeOf<CardView["currency"]>().toEqualTypeOf<WireCard["currency"]>();
    expectTypeOf<CardView["status"]>().toEqualTypeOf<WireCard["status"]>();
    expectTypeOf<CardView["network"]>().toEqualTypeOf<WireCard["network"]>();
  });

  it("readiness: mode and the requirement kinds", () => {
    expectTypeOf<CardReadiness["mode"]>().toEqualTypeOf<WireReadiness["mode"]>();
    expectTypeOf<CardRequirementKind>().toEqualTypeOf<WireRequirement["kind"]>();
    expectTypeOf<CardRequirementKind>().toEqualTypeOf<WireRequirement["kind"]>();
  });
});
