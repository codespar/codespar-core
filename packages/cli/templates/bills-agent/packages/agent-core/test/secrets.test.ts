import { describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { assertTestKey, isTestKey, NotATestKeyError, redactKey } from "../src/secrets.js";

// Built at runtime so the secret scan (which refuses key-shaped literals) stays honest about this file.
const TEST = ["csk", "test", "0123456789abcdef"].join("_");
const LIVE = ["csk", "live", "0123456789"].join("_");

describe("sandbox by construction", () => {
  it("accepts only csk_test_ keys", () => {
    expect(isTestKey(TEST)).toBe(true);
    expect(isTestKey(LIVE)).toBe(false);
    expect(isTestKey("csk_test_")).toBe(false);
    expect(isTestKey(undefined)).toBe(false);
    expect(() => assertTestKey(LIVE)).toThrow(NotATestKeyError);
  });

  it("refuses to build an API client with a live key, before any network", () => {
    expect(() => createCodeSparClient({ apiKey: LIVE })).toThrow(NotATestKeyError);
    expect(() => createCodeSparClient({ apiKey: undefined })).toThrow(NotATestKeyError);
    expect(createCodeSparClient({ apiKey: TEST })).toBeDefined();
  });

  it("redacts keys for logs", () => {
    expect(redactKey(TEST)).toBe("csk_test_…cdef");
    expect(redactKey(TEST)).not.toContain("0123456789");
  });
});
