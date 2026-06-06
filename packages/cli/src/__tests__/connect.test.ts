import { describe, it, expect } from "vitest";
import { assertHttpUrl } from "../commands/connect.js";

describe("assertHttpUrl — connect browser-open guard", () => {
  it("accepts http + https URLs and returns the parsed URL", () => {
    expect(assertHttpUrl("https://codespar.dev/connect/abc").protocol).toBe("https:");
    expect(assertHttpUrl("http://localhost:3000/connect").protocol).toBe("http:");
  });

  it("rejects non-http(s) schemes (file://, javascript:)", () => {
    expect(() => assertHttpUrl("file:///etc/passwd")).toThrow(/non-http/);
    expect(() => assertHttpUrl("javascript:alert(1)")).toThrow(/non-http/);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertHttpUrl("not a url")).toThrow(/malformed/);
  });

  it("still validates a metacharacter-laden but well-formed https URL (execFile makes it inert)", () => {
    // `(`/`)`/`$` are legal URL path chars; new URL() accepts them. The
    // injection-proofing is that openInBrowser now passes this as a literal
    // argv via execFile (no shell), not the validation here.
    expect(assertHttpUrl("https://codespar.dev/connect/$(id)").protocol).toBe("https:");
  });
});
