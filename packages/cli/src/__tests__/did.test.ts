import { describe, it, expect } from "vitest";
import { apiFallbackUrl, didWebToUrl } from "../did.js";

describe("did:web URL mapping", () => {
  it("maps a bare domain DID to /.well-known/did.json", () => {
    expect(didWebToUrl("did:web:id.codespar.dev")).toBe(
      "https://id.codespar.dev/.well-known/did.json",
    );
  });

  it("maps a path DID to /<segments>/did.json", () => {
    expect(didWebToUrl("did:web:id.codespar.dev:org_demo:a1")).toBe(
      "https://id.codespar.dev/org_demo/a1/did.json",
    );
  });

  it("decodes a %3A port in the domain segment", () => {
    expect(didWebToUrl("did:web:localhost%3A8080:org:a1")).toBe(
      "https://localhost:8080/org/a1/did.json",
    );
  });

  it("returns null for a non-did:web input", () => {
    expect(didWebToUrl("did:key:z6Mk...")).toBeNull();
    expect(didWebToUrl("not-a-did")).toBeNull();
  });

  it("builds the api.codespar.dev fallback with the full DID url-encoded", () => {
    expect(apiFallbackUrl("did:web:id.codespar.dev:org_demo:a1", "https://api.codespar.dev")).toBe(
      "https://api.codespar.dev/v1/agents/did%3Aweb%3Aid.codespar.dev%3Aorg_demo%3Aa1/did.json",
    );
  });

  it("trims a trailing slash on the base URL for the fallback", () => {
    expect(apiFallbackUrl("did:web:id.codespar.dev", "https://api.codespar.dev/")).toBe(
      "https://api.codespar.dev/v1/agents/did%3Aweb%3Aid.codespar.dev/did.json",
    );
  });
});
