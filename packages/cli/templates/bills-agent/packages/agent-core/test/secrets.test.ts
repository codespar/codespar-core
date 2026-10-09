import { describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { assertTestKey, CODESPAR_KEY_PLACEHOLDER, isTestKey, NotATestKeyError, redactKey, testKeyMessage, testKeyProblem } from "../src/secrets.js";

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

  it("tells the three mistakes apart (#50): no key, the placeholder, a key that is not a test key", () => {
    for (const missing of [undefined, "", "   "]) expect(testKeyProblem(missing)).toBe("missing");
    expect(testKeyProblem(CODESPAR_KEY_PLACEHOLDER)).toBe("placeholder");
    expect(testKeyProblem(LIVE)).toBe("not_test");
    expect(testKeyProblem("csk_test_")).toBe("not_test");
    expect(testKeyProblem(TEST)).toBeUndefined();
    expect(isTestKey(CODESPAR_KEY_PLACEHOLDER)).toBe(false);
    for (const [key, problem] of [[undefined, "missing"], [CODESPAR_KEY_PLACEHOLDER, "placeholder"], [LIVE, "not_test"]] as const) {
      try {
        assertTestKey(key);
        throw new Error("accepted");
      } catch (err) {
        expect(err).toBeInstanceOf(NotATestKeyError);
        expect((err as NotATestKeyError).problem).toBe(problem);
      }
    }
  });

  it("gives each its own remediation, naming the file the agent reads", () => {
    const file = "agents/bills-agent/.env";
    const missing = testKeyMessage("missing", file);
    const placeholder = testKeyMessage("placeholder", file);
    const live = testKeyMessage("not_test", file);
    expect(missing).toContain("CODESPAR_API_KEY is not set");
    expect(missing).toContain(`copy ${file}.example to ${file}`);
    expect(missing).not.toContain("live");
    expect(placeholder).toContain(`still the placeholder from .env.example (${CODESPAR_KEY_PLACEHOLDER})`);
    expect(placeholder).toContain(file);
    expect(placeholder).not.toContain("live");
    expect(live).toContain("a live key is refused");
    expect(new Set([missing, placeholder, live]).size).toBe(3);
    expect(new NotATestKeyError("missing", file).message).toBe(missing);
  });

  it("refuses to build a client on the placeholder too, before any network", () => {
    expect(() => createCodeSparClient({ apiKey: CODESPAR_KEY_PLACEHOLDER })).toThrow(/placeholder/);
    expect(() => createCodeSparClient({ apiKey: undefined })).toThrow(/is not set/);
  });

  it("redacts keys for logs", () => {
    expect(redactKey(TEST)).toBe("csk_test_…cdef");
    expect(redactKey(TEST)).not.toContain("0123456789");
  });
});
