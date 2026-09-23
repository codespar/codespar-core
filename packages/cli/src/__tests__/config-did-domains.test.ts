import { describe, it, expect } from "vitest";
import { parseDidDomains } from "../config.js";

describe("CODESPAR_DID_DOMAINS", () => {
  it("splits on commas, trims, drops empties", () => {
    expect(parseDidDomains("id.codespar.dev, id.other.example ,,")).toEqual([
      "id.codespar.dev",
      "id.other.example",
    ]);
  });

  it("is undefined when unset or empty", () => {
    expect(parseDidDomains(undefined)).toBeUndefined();
    expect(parseDidDomains("")).toBeUndefined();
    expect(parseDidDomains(" , ")).toBeUndefined();
  });
});
