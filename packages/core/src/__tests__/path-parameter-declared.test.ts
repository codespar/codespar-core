/**
 * Six operations templated a path parameter the served document never
 * declared (enterprise #2170). For the typed client that meant the `path`
 * option was typed `never`: `api.request("get", "/v1/consumers/{id}", { path:
 * { id } })` did not compile, and the only way through was a cast. The CLI
 * never noticed, because its positionals come from the path template.
 *
 * This file is checked by tsc. It compiles only while the snapshot declares
 * the parameter for every one of the six, and it carries a control: an
 * operation that was always declared must look the same.
 */

import { describe, expectTypeOf, it } from "vitest";

import type { ApiOperation, ApiRequestOptions } from "../api/types.js";
import { API_OPERATIONS } from "../generated/operations.js";
import SNAPSHOT from "../../openapi-snapshot.json" with { type: "json" };

describe("path parameters declared by enterprise #2170 (checked by tsc)", () => {
  it("types `path` as required for the six operations", () => {
    type ProviderGet = ApiOperation<"/v1/providers/{slug}", "get">;
    expectTypeOf<ApiRequestOptions<ProviderGet>["path"]>().toEqualTypeOf<{ slug: string }>();

    type ToolCallGet = ApiOperation<"/v1/tool-calls/{id}", "get">;
    expectTypeOf<ApiRequestOptions<ToolCallGet>["path"]>().toEqualTypeOf<{ id: string }>();

    type PolicyGet = ApiOperation<"/v1/policies/{id}", "get">;
    expectTypeOf<ApiRequestOptions<PolicyGet>["path"]>().toEqualTypeOf<{ id: string }>();

    type ConsumerGet = ApiOperation<"/v1/consumers/{id}", "get">;
    expectTypeOf<ApiRequestOptions<ConsumerGet>["path"]>().toEqualTypeOf<{ id: string }>();

    type ConsumerPatch = ApiOperation<"/v1/consumers/{id}", "patch">;
    expectTypeOf<ApiRequestOptions<ConsumerPatch>["path"]>().toEqualTypeOf<{ id: string }>();

    type PurchaseGet = ApiOperation<"/v1/shop/agent/purchases/{id}", "get">;
    expectTypeOf<ApiRequestOptions<PurchaseGet>["path"]>().toEqualTypeOf<{ id: string }>();

    // Control: an operation that always declared its parameter.
    type WalletGet = ApiOperation<"/v1/wallets/{id}", "get">;
    expectTypeOf<ApiRequestOptions<WalletGet>["path"]>().toEqualTypeOf<{ id: string }>();
  });

  it("the snapshot declares a path parameter for every templated segment", () => {
    const undeclared: string[] = [];
    for (const op of API_OPERATIONS) {
      const templated = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      if (templated.length === 0) continue;
      const item = (SNAPSHOT.document.paths as Record<string, Record<string, unknown>>)[op.path] ?? {};
      const operation = item[op.method] as { parameters?: { in: string; name: string }[] } | undefined;
      const declared = new Set(
        [...((item.parameters as { in: string; name: string }[] | undefined) ?? []), ...(operation?.parameters ?? [])]
          .filter((p) => p.in === "path")
          .map((p) => p.name),
      );
      for (const name of templated) if (!declared.has(name)) undeclared.push(`${op.method.toUpperCase()} ${op.path} {${name}}`);
    }
    if (undeclared.length > 0) throw new Error(`undeclared path parameters:\n${undeclared.join("\n")}`);
  });
});
